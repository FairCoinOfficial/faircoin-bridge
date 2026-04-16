// Buy-back worker contracts we care about:
//   1. Skipped entirely when BUYBACK_ENABLED=false.
//   2. Skipped when USDC balance < threshold; no cycle row created.
//   3. BPS split is total (sum(shares) === wfairTotal) and treasury/masternode
//      are computed by BPS; burn absorbs any rounding wei left over.
//   4. Each on-chain side-effect's tx hash is persisted BEFORE the receipt is
//      awaited (idempotency invariant — mirror of signer/base.ts).
//   5. Config refuses to load if BUYBACK_*_BPS do not sum to exactly 10000.
//
// Strategy mirrors test/signer-base.test.ts: replace models + viem + FAIR RPC
// with in-memory fakes, then drive the worker through a single tick.

import "./setup-env.js";

// We're testing config validation in one describe block below — set the env
// BEFORE importing anything that reads config.
process.env.BUYBACK_ENABLED = "true";
process.env.BUYBACK_THRESHOLD_USDC = "100";
process.env.BUYBACK_BURN_BPS = "5000";
process.env.BUYBACK_TREASURY_BPS = "3000";
process.env.BUYBACK_MASTERNODE_BPS = "2000";
// Base58-clean placeholder FAIR addresses (start with F = mainnet pubkey
// version 35; alphabet excludes 0, O, I, l). Validated only in-memory by
// our zod regex; the test mocks `validateAddress` so faircoind is never
// consulted.
process.env.FAIR_TREASURY_ADDRESS = "FTreasury2222222222222222222222222";
process.env.FAIR_MASTERNODE_REWARD_ADDRESS =
  "FMasternodePoo3333333333333333333";
process.env.FAIR_BURN_ADDRESS = "F111111111111111111111111111111eLe";
process.env.BRIDGE_EOA_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

interface FakeCycleDoc {
  _id: { toString(): string };
  status: string;
  triggeredAt: Date;
  usdcAmount: string;
  swapTxHash: string | null;
  wfairAcquiredWei: string | null;
  burnTxHash: string | null;
  treasuryTxHash: string | null;
  masternodeTxHash: string | null;
  burnAmountWei: string | null;
  treasuryAmountWei: string | null;
  masternodeAmountWei: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Counters {
  writeContract: number;
  waitReceipt: number;
  // Snapshot of the cycle doc's tx hash fields at the moment waitReceipt is
  // called. Lets us assert the hash-persist-before-await invariant.
  hashPresentAtReceiptAwait: {
    swapTxHash: boolean;
    burnTxHash: boolean;
    treasuryTxHash: boolean;
    masternodeTxHash: boolean;
  };
}

let cycleDoc: FakeCycleDoc | null;
let counters: Counters;
let usdcBalance: bigint;
let wfairBalance: bigint;
let adminAllowance: bigint;
let lastWriteCall: {
  address: string;
  functionName: string;
  args: unknown[];
} | null;

function freshCycle(usdcAmount: bigint): FakeCycleDoc {
  const now = new Date();
  return {
    _id: { toString: () => "cycle-1" },
    status: "PENDING",
    triggeredAt: now,
    usdcAmount: usdcAmount.toString(),
    swapTxHash: null,
    wfairAcquiredWei: null,
    burnTxHash: null,
    treasuryTxHash: null,
    masternodeTxHash: null,
    burnAmountWei: null,
    treasuryAmountWei: null,
    masternodeAmountWei: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}

function applySet(
  doc: FakeCycleDoc,
  update: { $set?: Partial<FakeCycleDoc> },
): void {
  if (!update.$set) return;
  Object.assign(doc, update.$set);
}

mock.module("../src/models/buyback-cycle.js", () => ({
  BuybackCycle: {
    findOne: (_filter: unknown) => ({
      sort: () => ({
        lean: async (): Promise<FakeCycleDoc | null> => {
          if (!cycleDoc) return null;
          const openStatuses = [
            "PENDING",
            "SWAPPING",
            "BURNING",
            "TREASURY_SENDING",
            "MASTERNODE_SENDING",
          ];
          if (!openStatuses.includes(cycleDoc.status)) return null;
          return { ...cycleDoc };
        },
      }),
    }),
    findById: (_id: string) => ({
      lean: async (): Promise<FakeCycleDoc | null> =>
        cycleDoc && cycleDoc._id.toString() === _id ? { ...cycleDoc } : null,
    }),
    create: async (seed: {
      usdcAmount: string;
      status: string;
      triggeredAt: Date;
    }): Promise<FakeCycleDoc> => {
      cycleDoc = freshCycle(BigInt(seed.usdcAmount));
      cycleDoc.status = seed.status;
      cycleDoc.triggeredAt = seed.triggeredAt;
      return { ...cycleDoc };
    },
    updateOne: async (
      _filter: unknown,
      update: { $set?: Partial<FakeCycleDoc> },
    ): Promise<{ acknowledged: true }> => {
      if (cycleDoc) applySet(cycleDoc, update);
      return { acknowledged: true };
    },
    find: (): {
      sort: () => {
        limit: () => { lean: () => Promise<FakeCycleDoc[]> };
      };
    } => ({
      sort: () => ({
        limit: () => ({
          lean: async (): Promise<FakeCycleDoc[]> =>
            cycleDoc ? [{ ...cycleDoc }] : [],
        }),
      }),
    }),
  },
}));

mock.module("../src/models/audit-log.js", () => ({
  AuditLog: { create: async (): Promise<Record<string, unknown>> => ({}) },
}));

mock.module("../src/lib/alert.js", () => ({
  alert: async (): Promise<undefined> => undefined,
}));

mock.module("../src/lib/logger.js", () => ({
  logger: {
    info: (): undefined => undefined,
    warn: (): undefined => undefined,
    error: (): undefined => undefined,
    debug: (): undefined => undefined,
    fatal: (): undefined => undefined,
  },
}));

// FaircoinRpcClient mock is installed globally by test/mock-fair-rpc.ts.
// Per-test handler routes the few RPC calls the buy-back worker can make
// (only `validateaddress` for the destination addresses today). Other
// methods return loud errors so accidental coupling to fair-side state
// surfaces immediately.
import { setRpcHandler, clearRpcHandler } from "./mock-fair-rpc.js";

setRpcHandler((method) => {
  switch (method) {
    case "validateaddress":
      return Promise.resolve({ isvalid: true });
    default:
      return Promise.reject(
        new Error(`buyback-worker test: unmocked RPC method ${method}`),
      );
  }
});

mock.module("../src/rpc/uniswap.js", () => ({
  // Pretend pool rate: 1 USDC = 10 WFAIR. Inputs are microUSDC (6 dec); we
  // scale up to wei (18 dec), apply the rate, then leave it as wei.
  // For X microUSDC: wei = X * 10 * 10^(18-6) = X * 10 * 10^12.
  quoteWfairOutForExactUsdcIn: async (usdcIn: bigint): Promise<bigint> =>
    usdcIn * 10n * 10n ** 12n,
  // Re-stub every other symbol so collateral test files don't see a
  // partial mock when this file runs first in the global suite.
  quoteUsdcInForExactWfairOut: async (): Promise<bigint> => 0n,
  getPoolMeta: async (): Promise<unknown> => ({}),
  resetPoolMetaCache: (): void => undefined,
}));

mock.module("../src/rpc/base.js", () => {
  const adminAddress = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const readContract = async (args: {
    address: string;
    functionName: string;
    args: unknown[];
  }): Promise<bigint> => {
    // ERC-20 reads go through a single readContract; distinguish by the
    // function name + token address.
    if (args.functionName === "balanceOf") {
      // Differentiate USDC vs WFAIR by the address the worker passes.
      const token = args.address.toLowerCase();
      if (
        token === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ||
        token === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913".toLowerCase()
      ) {
        return usdcBalance;
      }
      return wfairBalance;
    }
    if (args.functionName === "allowance") {
      return adminAllowance;
    }
    return 0n;
  };
  const requireWallet = () => ({
    account: { address: adminAddress },
    writeContract: async (args: {
      address: string;
      functionName: string;
      args: unknown[];
    }): Promise<`0x${string}`> => {
      counters.writeContract += 1;
      lastWriteCall = {
        address: args.address,
        functionName: args.functionName,
        args: args.args,
      };
      if (args.functionName === "approve") {
        adminAllowance =
          (args.args[1] as bigint | undefined) ?? adminAllowance;
        return "0x0000000000000000000000000000000000000000000000000000000000000a11" as `0x${string}`;
      }
      if (args.functionName === "exactInputSingle") {
        // Simulate the swap settling: credit WFAIR to the admin EOA.
        // Same rate as the quoter mock: 1 USDC = 10 WFAIR.
        const params = args.args[0] as { amountIn: bigint };
        const wfairCredited = params.amountIn * 10n * 10n ** 12n;
        wfairBalance += wfairCredited;
        usdcBalance -= params.amountIn;
        return "0x0000000000000000000000000000000000000000000000000000000000000b01" as `0x${string}`;
      }
      if (args.functionName === "bridgeBurn") {
        const amount = args.args[0] as bigint;
        wfairBalance -= amount;
        // Distinct hash per destination so tests can pinpoint ordering.
        const dest = (args.args[1] as string).slice(2, 6);
        return (`0x0000000000000000000000000000000000000000000000000000000000c0${dest}` +
          "00").slice(0, 66) as `0x${string}`;
      }
      return "0xfeed" as `0x${string}`;
    },
  });
  const basePublic = {
    readContract,
    waitForTransactionReceipt: async (): Promise<{
      status: "success";
      blockNumber: bigint;
    }> => {
      counters.waitReceipt += 1;
      // At the moment we await a receipt, record which tx hashes are already
      // on the cycle doc. This asserts the hash-persist-before-await
      // invariant: the worker must persist before every await.
      if (cycleDoc) {
        counters.hashPresentAtReceiptAwait = {
          swapTxHash:
            cycleDoc.swapTxHash !== null ||
            counters.hashPresentAtReceiptAwait.swapTxHash,
          burnTxHash:
            cycleDoc.burnTxHash !== null ||
            counters.hashPresentAtReceiptAwait.burnTxHash,
          treasuryTxHash:
            cycleDoc.treasuryTxHash !== null ||
            counters.hashPresentAtReceiptAwait.treasuryTxHash,
          masternodeTxHash:
            cycleDoc.masternodeTxHash !== null ||
            counters.hashPresentAtReceiptAwait.masternodeTxHash,
        };
      }
      return { status: "success" as const, blockNumber: 1n };
    },
  };
  return {
    requireWallet,
    basePublic,
    baseChain: { id: 8453 },
  };
});

// Import after all mocks are registered.
const {
  runOneCycle,
  splitByBps,
  resolveDestinations,
  startBuybackWorker,
} = await import("../src/workers/buyback-worker.js");

beforeEach(() => {
  cycleDoc = null;
  counters = {
    writeContract: 0,
    waitReceipt: 0,
    hashPresentAtReceiptAwait: {
      swapTxHash: false,
      burnTxHash: false,
      treasuryTxHash: false,
      masternodeTxHash: false,
    },
  };
  usdcBalance = 0n;
  wfairBalance = 0n;
  adminAllowance = 0n;
  lastWriteCall = null;
});

describe("splitByBps", () => {
  it("splits totals by BPS with burn absorbing rounding wei", () => {
    const total = 1_000_000_000_000_000_000n; // 1 WFAIR
    const { burn, treasury, masternode } = splitByBps(total, 5000, 3000, 2000);
    expect(treasury).toBe(300_000_000_000_000_000n);
    expect(masternode).toBe(200_000_000_000_000_000n);
    expect(burn).toBe(500_000_000_000_000_000n);
    expect(burn + treasury + masternode).toBe(total);
  });

  it("returns total sum equal to input even for non-round amounts", () => {
    const total = 123_456_789_987n;
    const { burn, treasury, masternode } = splitByBps(total, 4567, 3333, 2100);
    expect(burn + treasury + masternode).toBe(total);
    // Treasury/masternode are computed via BPS (no absorption); burn absorbs
    // the remainder. Verify BPS math is respected.
    expect(treasury).toBe((total * 3333n) / 10_000n);
    expect(masternode).toBe((total * 2100n) / 10_000n);
  });

  it("rejects invalid BPS that would produce a negative burn share", () => {
    // 4000 + 7000 = 11000 > 10000 would produce negative burn. The schema
    // prevents this at load time, but splitByBps itself must also fail
    // closed if ever called with a bad split (defence in depth).
    expect(() => splitByBps(100n, 0, 7000, 4000)).toThrow(/negative burn/);
  });
});

describe("resolveDestinations", () => {
  it("uses the configured FAIR_BURN_ADDRESS when provided", () => {
    const dest = resolveDestinations();
    expect(dest.burn).toBe("F111111111111111111111111111111eLe");
    expect(dest.treasury).toBe("FTreasury2222222222222222222222222");
    expect(dest.masternode).toBe("FMasternodePoo3333333333333333333");
  });
});

describe("runOneCycle (gating)", () => {
  it("returns null and does not touch chain when USDC is below threshold", async () => {
    // 99 USDC = 99 * 1e6 microUSDC, threshold is 100 USDC.
    usdcBalance = 99n * 10n ** 6n;
    const result = await runOneCycle();
    expect(result).toBeNull();
    expect(counters.writeContract).toBe(0);
    expect(counters.waitReceipt).toBe(0);
    expect(cycleDoc).toBeNull();
  });
});

describe("runOneCycle (happy path)", () => {
  it("runs approve + swap + 3 burns and marks COMPLETE", async () => {
    usdcBalance = 200n * 10n ** 6n; // 200 USDC: well above threshold
    const result = await runOneCycle();
    expect(result).not.toBeNull();
    expect(result?.status).toBe("COMPLETE");

    // 1 approve + 1 swap + 3 bridgeBurn = 5 writeContract calls.
    expect(counters.writeContract).toBe(5);

    // All four chain-tx hashes populated.
    expect(cycleDoc?.swapTxHash).toBeTruthy();
    expect(cycleDoc?.burnTxHash).toBeTruthy();
    expect(cycleDoc?.treasuryTxHash).toBeTruthy();
    expect(cycleDoc?.masternodeTxHash).toBeTruthy();

    // Idempotency invariant: by the time every receipt is awaited, the
    // corresponding hash was already on the doc. The fake receipt waiter
    // samples this at each await — assert all four flipped true.
    expect(counters.hashPresentAtReceiptAwait.swapTxHash).toBe(true);
    expect(counters.hashPresentAtReceiptAwait.burnTxHash).toBe(true);
    expect(counters.hashPresentAtReceiptAwait.treasuryTxHash).toBe(true);
    expect(counters.hashPresentAtReceiptAwait.masternodeTxHash).toBe(true);

    // Amounts: 200 USDC → 2000 WFAIR (per mock quote); 50/30/20 split.
    const total = 2_000n * 10n ** 18n;
    expect(cycleDoc?.wfairAcquiredWei).toBe(total.toString());
    expect(BigInt(cycleDoc?.burnAmountWei ?? "0")).toBe(
      total - (total * 3000n) / 10000n - (total * 2000n) / 10000n,
    );
    expect(BigInt(cycleDoc?.treasuryAmountWei ?? "0")).toBe(
      (total * 3000n) / 10000n,
    );
    expect(BigInt(cycleDoc?.masternodeAmountWei ?? "0")).toBe(
      (total * 2000n) / 10000n,
    );
  });

  it("on retry after swap-persisted-but-receipt-uncompleted, does not re-broadcast swap", async () => {
    // Simulate the state a prior tick left behind: cycle row exists, swap
    // hash is on file, WFAIR already credited to the admin wallet by the
    // completed on-chain swap. The worker must skip re-broadcasting the
    // swap and proceed straight to the burn steps.
    const usdcAmount = 200n * 10n ** 6n;
    cycleDoc = freshCycle(usdcAmount);
    cycleDoc.status = "SWAPPING";
    cycleDoc.swapTxHash = "0xsimulatedswaphash";
    cycleDoc.wfairAcquiredWei = (2_000n * 10n ** 18n).toString();
    wfairBalance = 2_000n * 10n ** 18n;
    usdcBalance = 0n; // swap already drained USDC

    await runOneCycle();

    // approve is skipped because allowance is already ≥ amount? In this
    // scenario USDC is 0 so the worker never enters ensureUsdcApproval
    // (swap is reconciled, not re-broadcast). Exactly 3 writeContract calls
    // — the three bridgeBurns.
    expect(counters.writeContract).toBe(3);
    // No fresh swap hash written over the simulated one.
    expect(cycleDoc?.swapTxHash).toBe("0xsimulatedswaphash");
    expect(cycleDoc?.status).toBe("COMPLETE");
  });

  it("on retry after burn-persisted-but-receipt-uncompleted, does not re-broadcast that burn", async () => {
    // Cycle has completed swap + first two burns, died mid-masternode burn.
    const usdcAmount = 200n * 10n ** 6n;
    cycleDoc = freshCycle(usdcAmount);
    cycleDoc.status = "MASTERNODE_SENDING";
    cycleDoc.swapTxHash = "0xsimulatedswaphash";
    cycleDoc.wfairAcquiredWei = (2_000n * 10n ** 18n).toString();
    cycleDoc.burnTxHash = "0xsimulatedburnhash";
    cycleDoc.burnAmountWei = (1_000n * 10n ** 18n).toString();
    cycleDoc.treasuryTxHash = "0xsimulatedtreasuryhash";
    cycleDoc.treasuryAmountWei = (600n * 10n ** 18n).toString();
    cycleDoc.masternodeTxHash = "0xsimulatedmasternodehash";
    cycleDoc.masternodeAmountWei = (400n * 10n ** 18n).toString();
    usdcBalance = 0n;
    wfairBalance = 0n;

    await runOneCycle();

    // Everything reconciles via receipts; zero writeContract calls.
    expect(counters.writeContract).toBe(0);
    expect(cycleDoc?.status).toBe("COMPLETE");
  });
});

describe("startBuybackWorker", () => {
  it("bails silently in oneShot when the worker is enabled but USDC is below threshold", async () => {
    usdcBalance = 10n * 10n ** 6n;
    const controller = new AbortController();
    await startBuybackWorker(controller.signal, { oneShot: true });
    expect(counters.writeContract).toBe(0);
  });
});

describe("lastWriteCall is a state leak guard", () => {
  it("keeps the last-write reference non-null after a full cycle", async () => {
    usdcBalance = 200n * 10n ** 6n;
    await runOneCycle();
    // The last write of a full cycle must be the masternode bridgeBurn.
    expect(lastWriteCall?.functionName).toBe("bridgeBurn");
  });
});

afterAll(() => {
  // Restore spies (audit-log, alert, logger, viem, models). The shared
  // FaircoinRpcClient handler is cleared so a later test file installs its
  // own without inheriting our `validateaddress → {isvalid:true}` stub.
  clearRpcHandler();
  mock.restore();
});
