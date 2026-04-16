import { getAddress, type Address, type Hash } from "viem";
import { config } from "../config.js";
import { AuditLog } from "../models/audit-log.js";
import {
  BuybackCycle,
  type BuybackCycleDoc,
  type BuybackCycleStatus,
} from "../models/buyback-cycle.js";
import { alert } from "../lib/alert.js";
import { deriveCanonicalBurnAddress } from "../lib/burn-address.js";
import { fairAddressToBytes } from "../lib/fair-address-bytes.js";
import { logger } from "../lib/logger.js";
import { basePublic, baseChain, requireWallet } from "../rpc/base.js";
import { validateAddress as fairValidateAddress } from "../rpc/fair.js";
import {
  erc20Abi,
  uniswapV3SwapRouterAbi,
} from "../rpc/uniswap-abi.js";
import { quoteWfairOutForExactUsdcIn } from "../rpc/uniswap.js";
import { wfairAbi } from "../rpc/wfair-abi.js";

/**
 * Buy-back + burn + community-treasury distribution worker.
 *
 * Pipeline per cycle:
 *   1. Read admin EOA USDC balance on Base.
 *   2. If below BUYBACK_THRESHOLD_USDC, skip and sleep.
 *   3. Otherwise, create a PENDING BuybackCycle row capturing the amount.
 *   4. Approve the Uniswap v3 SwapRouter for the claimed USDC amount.
 *   5. exactInputSingle USDC → WFAIR; persist swapTxHash BEFORE awaiting receipt.
 *   6. Read the realised WFAIR delta that landed on the admin EOA.
 *   7. Split WFAIR per BPS config and call bridgeBurn three times:
 *        - burn address → provably-unspendable (deflation)
 *        - treasury    → community-controlled hot wallet
 *        - masternode  → pool consumed by the masternode-reward booster (#29)
 *      Each burn tx hash is persisted BEFORE its receipt is awaited.
 *   8. Mark the row COMPLETE. The existing base-watcher will pick up each
 *      BridgeBurn event and queue a release via signRelease, delivering FAIR
 *      to the three destinations.
 *
 * Idempotency (CRITICAL — real funds):
 *   This mirrors the pattern in src/signer/base.ts and src/signer/fair.ts:
 *   every on-chain side-effect's tx hash is persisted BEFORE the next state
 *   transition. On a tick after a crash, the reconciliation branch picks up
 *   existing hashes and waits on receipts instead of re-broadcasting. A
 *   second crash during approve → swap → three burns is recoverable — the
 *   worker will resume exactly where it left off, never re-issuing a
 *   duplicate tx.
 */

const BPS_DENOM = 10_000n;
const POOL_FEE = 3000; // 0.30% — matches the deployed WFAIR/USDC v3 pool
const USDC_DECIMALS = 6;
// Tighter slippage buffer than the user-facing /buy quote. The buy-back
// worker runs on its own schedule; if the pool has moved 2% the swap will
// revert and we'll retry next tick rather than eat the slippage.
const BUYBACK_MINOUT_BUFFER_BPS = 200n;

export interface BuybackWorkerOptions {
  /** Optional override for the tick interval; defaults to config value. */
  intervalMs?: number;
  /** When true, run a single tick and return instead of looping. */
  oneShot?: boolean;
}

interface Destinations {
  burn: string;
  treasury: string;
  masternode: string;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolve the three FAIR destinations, substituting the canonical burn
 * address when FAIR_BURN_ADDRESS is not explicitly set. Treasury +
 * masternode are REQUIRED by config.superRefine when the worker is enabled,
 * so we can safely assert their presence here.
 */
export function resolveDestinations(): Destinations {
  const burn =
    config.FAIR_BURN_ADDRESS ?? deriveCanonicalBurnAddress(config.FAIR_NETWORK);
  const treasury = config.FAIR_TREASURY_ADDRESS;
  const masternode = config.FAIR_MASTERNODE_REWARD_ADDRESS;
  if (!treasury || !masternode) {
    throw new Error(
      "buyback: FAIR_TREASURY_ADDRESS and FAIR_MASTERNODE_REWARD_ADDRESS must be set when BUYBACK_ENABLED=true",
    );
  }
  return { burn, treasury, masternode };
}

/**
 * Compute the three burn amounts from the realised WFAIR. Burn share
 * absorbs any wei left over from integer division so sum(returned) ==
 * wfairTotal exactly.
 */
export function splitByBps(
  wfairTotal: bigint,
  burnBps: number,
  treasuryBps: number,
  masternodeBps: number,
): { burn: bigint; treasury: bigint; masternode: bigint } {
  const treasury = (wfairTotal * BigInt(treasuryBps)) / BPS_DENOM;
  const masternode = (wfairTotal * BigInt(masternodeBps)) / BPS_DENOM;
  const burn = wfairTotal - treasury - masternode;
  // Sanity: ensure the burn share is non-negative and the BPS math was sane.
  if (burn < 0n) {
    throw new Error(
      `splitByBps produced negative burn share (burnBps=${String(burnBps)}, treasuryBps=${String(treasuryBps)}, masternodeBps=${String(masternodeBps)})`,
    );
  }
  return { burn, treasury, masternode };
}

async function readUsdcBalance(address: Address): Promise<bigint> {
  return basePublic.readContract({
    address: config.USDC_BASE_ADDRESS as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

async function readWfairBalance(address: Address): Promise<bigint> {
  return basePublic.readContract({
    address: config.WFAIR_CONTRACT_ADDRESS as `0x${string}`,
    abi: wfairAbi,
    functionName: "balanceOf",
    args: [address],
  });
}

async function readUsdcAllowance(owner: Address): Promise<bigint> {
  return basePublic.readContract({
    address: config.USDC_BASE_ADDRESS as `0x${string}`,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, config.UNISWAP_V3_SWAP_ROUTER as `0x${string}`],
  });
}

/**
 * Claim the right to start a new cycle. Returns null if a cycle is already
 * in-flight (status != COMPLETE && != FAILED). This prevents two overlapping
 * ticks — if another replica or the admin endpoint fires concurrently — from
 * double-spending USDC fees.
 */
async function claimOrLoadInFlightCycle(
  thresholdMicroUsdc: bigint,
  currentUsdcBalance: bigint,
): Promise<BuybackCycleDoc | null> {
  const openStatuses: BuybackCycleStatus[] = [
    "PENDING",
    "SWAPPING",
    "BURNING",
    "TREASURY_SENDING",
    "MASTERNODE_SENDING",
  ];
  // If a cycle is already open, resume it. There can be at most one in-flight
  // cycle at any time because the admin EOA's USDC balance is shared state.
  const open = await BuybackCycle.findOne({
    status: { $in: openStatuses },
  })
    .sort({ createdAt: 1 })
    .lean<BuybackCycleDoc | null>();
  if (open) return open;

  // No open cycle and we're below threshold → nothing to do.
  if (currentUsdcBalance < thresholdMicroUsdc) return null;

  // Atomically ensure there's still no open cycle before we create one. A
  // findOneAndUpdate(upsert) with a status filter would be cleaner, but we
  // can't craft a single-document upsert that simultaneously (a) creates a
  // row if none open, (b) refuses if one open. Two-step create is safe
  // because openStatuses is disjoint from {COMPLETE, FAILED} and the worker
  // is single-writer per process; the admin endpoint serialises through the
  // same check before calling runOneCycle.
  return await BuybackCycle.create({
    triggeredAt: new Date(),
    usdcAmount: currentUsdcBalance.toString(),
    status: "PENDING",
  });
}

async function ensureUsdcApproval(
  admin: Address,
  amount: bigint,
): Promise<void> {
  const allowance = await readUsdcAllowance(admin);
  if (allowance >= amount) return;
  const wallet = requireWallet();
  if (!wallet.account) {
    throw new Error("bridge wallet has no account configured");
  }
  // Approve exactly the requested amount. Base mainnet USDC is the canonical
  // Circle token which does NOT require the "approve to 0 first" dance.
  const hash = await wallet.writeContract({
    address: config.USDC_BASE_ADDRESS as `0x${string}`,
    abi: erc20Abi,
    functionName: "approve",
    args: [config.UNISWAP_V3_SWAP_ROUTER as `0x${string}`, amount],
    chain: baseChain,
    account: wallet.account,
  });
  const receipt = await basePublic.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`buyback USDC approve reverted (${hash})`);
  }
  logger.info({ approveTxHash: hash, amount: amount.toString() }, "buyback: USDC approval landed");
}

async function broadcastSwap(
  admin: Address,
  usdcAmount: bigint,
): Promise<{ txHash: Hash; minOut: bigint }> {
  // Fresh quote at swap time so minOut tracks real spot.
  const expectedWfair = await quoteWfairOutForExactUsdcIn(usdcAmount);
  const minOut =
    (expectedWfair * (BPS_DENOM - BUYBACK_MINOUT_BUFFER_BPS)) / BPS_DENOM;
  const wallet = requireWallet();
  if (!wallet.account) {
    throw new Error("bridge wallet has no account configured");
  }
  const txHash = await wallet.writeContract({
    address: config.UNISWAP_V3_SWAP_ROUTER as `0x${string}`,
    abi: uniswapV3SwapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: config.USDC_BASE_ADDRESS as `0x${string}`,
        tokenOut: config.WFAIR_CONTRACT_ADDRESS as `0x${string}`,
        fee: POOL_FEE,
        recipient: admin,
        amountIn: usdcAmount,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
    chain: baseChain,
    account: wallet.account,
  });
  return { txHash, minOut };
}

async function broadcastBridgeBurn(
  amountWei: bigint,
  fairDestination: string,
): Promise<Hash> {
  const wallet = requireWallet();
  if (!wallet.account) {
    throw new Error("bridge wallet has no account configured");
  }
  return await wallet.writeContract({
    address: config.WFAIR_CONTRACT_ADDRESS as `0x${string}`,
    abi: wfairAbi,
    functionName: "bridgeBurn",
    args: [amountWei, fairAddressToBytes(fairDestination)],
    chain: baseChain,
    account: wallet.account,
  });
}

async function markFailed(cycleId: string, message: string): Promise<void> {
  await BuybackCycle.updateOne(
    { _id: cycleId },
    { $set: { status: "FAILED", errorMessage: message } },
  );
  await alert("buyback cycle failed", { cycleId, message });
}

/**
 * Swap step. Persists swapTxHash BEFORE awaiting the receipt; on retry the
 * existing-hash branch takes over and waits the same receipt.
 */
async function runSwapStep(
  cycle: BuybackCycleDoc,
  admin: Address,
): Promise<{ wfairAcquired: bigint; updated: BuybackCycleDoc }> {
  const cycleId = cycle._id.toString();
  const usdcAmount = BigInt(cycle.usdcAmount);

  // Resume path: swap already broadcast, just wait on the receipt and read
  // the realised WFAIR.
  if (cycle.swapTxHash) {
    const txHash = cycle.swapTxHash as Hash;
    logger.warn({ cycleId, txHash }, "buyback: reconciling existing swap on retry");
    const receipt = await basePublic.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      await markFailed(cycleId, `swap reverted (${txHash})`);
      throw new Error(`buyback swap reverted: ${txHash}`);
    }
    // If wfairAcquiredWei is on file, trust it; otherwise read current balance.
    // The balance read may overstate if USDC fees arrived during the window,
    // but since we claim the row's usdcAmount snapshot at cycle start, any
    // later deposits stay in the EOA for the next cycle and don't affect this
    // cycle's math.
    const wfairAcquired = cycle.wfairAcquiredWei
      ? BigInt(cycle.wfairAcquiredWei)
      : await readWfairBalance(admin);
    if (!cycle.wfairAcquiredWei) {
      await BuybackCycle.updateOne(
        { _id: cycleId },
        { $set: { wfairAcquiredWei: wfairAcquired.toString() } },
      );
    }
    const updated = await BuybackCycle.findById(cycleId).lean<BuybackCycleDoc | null>();
    if (!updated) {
      throw new Error(`buyback: cycle ${cycleId} vanished during swap reconcile`);
    }
    return { wfairAcquired, updated };
  }

  // Fresh path: claim SWAPPING, approve, broadcast, persist hash, await receipt.
  await BuybackCycle.updateOne(
    { _id: cycleId },
    { $set: { status: "SWAPPING" } },
  );
  await ensureUsdcApproval(admin, usdcAmount);

  // Capture WFAIR balance BEFORE the swap so the post-swap delta gives us
  // the true realised amount (handles the edge case where the EOA is
  // holding residual WFAIR from an interrupted prior cycle).
  const wfairBefore = await readWfairBalance(admin);

  const { txHash } = await broadcastSwap(admin, usdcAmount);

  // Persist hash BEFORE waiting on receipt. Order matters (see signer/base.ts
  // idempotency note).
  await BuybackCycle.updateOne(
    { _id: cycleId },
    { $set: { swapTxHash: txHash.toLowerCase() } },
  );

  const receipt = await basePublic.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    await markFailed(cycleId, `swap reverted (${txHash})`);
    throw new Error(`buyback swap reverted: ${txHash}`);
  }

  const wfairAfter = await readWfairBalance(admin);
  const wfairAcquired = wfairAfter - wfairBefore;
  if (wfairAcquired <= 0n) {
    await markFailed(
      cycleId,
      `swap settled but admin WFAIR balance did not increase (before=${wfairBefore.toString()} after=${wfairAfter.toString()})`,
    );
    throw new Error("buyback swap yielded no WFAIR");
  }

  await BuybackCycle.updateOne(
    { _id: cycleId },
    { $set: { wfairAcquiredWei: wfairAcquired.toString() } },
  );

  const updated = await BuybackCycle.findById(cycleId).lean<BuybackCycleDoc | null>();
  if (!updated) {
    throw new Error(`buyback: cycle ${cycleId} vanished after swap`);
  }

  logger.info(
    {
      cycleId,
      swapTxHash: txHash,
      usdcIn: usdcAmount.toString(),
      wfairOut: wfairAcquired.toString(),
    },
    "buyback: swap landed",
  );

  return { wfairAcquired, updated };
}

interface BurnStepConfig {
  /** Status the cycle transitions to while this burn is in-flight. */
  status: BuybackCycleStatus;
  /** Field on the BuybackCycle doc holding this burn's tx hash. */
  txHashField: "burnTxHash" | "treasuryTxHash" | "masternodeTxHash";
  /** Field on the BuybackCycle doc holding this burn's amount. */
  amountField: "burnAmountWei" | "treasuryAmountWei" | "masternodeAmountWei";
  /** Human-readable label used in logs/alerts. */
  label: "burn" | "treasury" | "masternode";
  /** FAIR address embedded in the BridgeBurn event. */
  destination: string;
  /** WFAIR amount (wei) to burn to this destination. */
  amount: bigint;
}

/**
 * Idempotent single-burn step. Re-entrant: if the hash is already on file,
 * reconciles via the receipt instead of re-broadcasting.
 */
async function runBurnStep(
  cycle: BuybackCycleDoc,
  step: BurnStepConfig,
): Promise<void> {
  const cycleId = cycle._id.toString();
  const existingHash = cycle[step.txHashField];

  if (existingHash) {
    logger.warn(
      { cycleId, label: step.label, txHash: existingHash },
      "buyback: reconciling existing burn on retry",
    );
    const receipt = await basePublic.waitForTransactionReceipt({
      hash: existingHash as Hash,
    });
    if (receipt.status !== "success") {
      await markFailed(
        cycleId,
        `${step.label} bridgeBurn reverted (${existingHash})`,
      );
      throw new Error(
        `buyback ${step.label} bridgeBurn reverted: ${existingHash}`,
      );
    }
    return;
  }

  // Fresh path. Record the amount, flip status, broadcast, persist hash
  // BEFORE awaiting receipt.
  await BuybackCycle.updateOne(
    { _id: cycleId },
    {
      $set: {
        status: step.status,
        [step.amountField]: step.amount.toString(),
      },
    },
  );

  const txHash = await broadcastBridgeBurn(step.amount, step.destination);

  await BuybackCycle.updateOne(
    { _id: cycleId },
    { $set: { [step.txHashField]: txHash.toLowerCase() } },
  );

  const receipt = await basePublic.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    await markFailed(
      cycleId,
      `${step.label} bridgeBurn reverted (${txHash})`,
    );
    throw new Error(`buyback ${step.label} bridgeBurn reverted: ${txHash}`);
  }

  logger.info(
    {
      cycleId,
      label: step.label,
      txHash,
      amount: step.amount.toString(),
      destination: step.destination,
    },
    "buyback: bridgeBurn landed",
  );
}

/**
 * Validate the three FAIR destinations once per cycle against the configured
 * faircoind node. Fails closed if any is rejected — we'd rather skip the
 * cycle than let a bad address absorb WFAIR we cannot release from.
 */
async function validateDestinations(dest: Destinations): Promise<void> {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["burn", dest.burn],
    ["treasury", dest.treasury],
    ["masternode", dest.masternode],
  ];
  for (const [label, address] of pairs) {
    const result = await fairValidateAddress(address).catch(() => null);
    if (!result || !result.isvalid) {
      throw new Error(
        `buyback: ${label} FAIR address ${address} failed validateaddress — refusing to run cycle`,
      );
    }
  }
}

/**
 * Run exactly one cycle end-to-end. Returns the final cycle doc (COMPLETE or
 * no-op), or null if there was nothing to do this tick.
 *
 * Exported so the admin API can trigger a single cycle on demand.
 */
export async function runOneCycle(): Promise<BuybackCycleDoc | null> {
  if (!config.BUYBACK_ENABLED) return null;

  const wallet = requireWallet();
  if (!wallet.account) {
    throw new Error(
      "buyback: bridge wallet has no account — BRIDGE_EOA_PRIVATE_KEY required",
    );
  }
  const admin = getAddress(wallet.account.address);

  const destinations = resolveDestinations();
  await validateDestinations(destinations);

  const thresholdMicroUsdc =
    BigInt(config.BUYBACK_THRESHOLD_USDC) * 10n ** BigInt(USDC_DECIMALS);
  const currentUsdc = await readUsdcBalance(admin);

  const cycle = await claimOrLoadInFlightCycle(thresholdMicroUsdc, currentUsdc);
  if (!cycle) {
    logger.debug(
      {
        admin,
        usdcBalance: currentUsdc.toString(),
        threshold: thresholdMicroUsdc.toString(),
      },
      "buyback: below threshold, skipping",
    );
    return null;
  }

  const cycleId = cycle._id.toString();
  logger.info(
    {
      cycleId,
      admin,
      usdcAmount: cycle.usdcAmount,
      status: cycle.status,
    },
    "buyback: cycle in progress",
  );

  try {
    const swap = await runSwapStep(cycle, admin);
    const wfairAcquired = swap.wfairAcquired;
    let liveCycle = swap.updated;

    const shares = splitByBps(
      wfairAcquired,
      config.BUYBACK_BURN_BPS,
      config.BUYBACK_TREASURY_BPS,
      config.BUYBACK_MASTERNODE_BPS,
    );

    // Each burn step is idempotent. We always run all three in order; already-
    // completed steps short-circuit via the existing-hash branch.
    const steps: BurnStepConfig[] = [
      {
        status: "BURNING",
        txHashField: "burnTxHash",
        amountField: "burnAmountWei",
        label: "burn",
        destination: destinations.burn,
        amount: shares.burn,
      },
      {
        status: "TREASURY_SENDING",
        txHashField: "treasuryTxHash",
        amountField: "treasuryAmountWei",
        label: "treasury",
        destination: destinations.treasury,
        amount: shares.treasury,
      },
      {
        status: "MASTERNODE_SENDING",
        txHashField: "masternodeTxHash",
        amountField: "masternodeAmountWei",
        label: "masternode",
        destination: destinations.masternode,
        amount: shares.masternode,
      },
    ];

    for (const step of steps) {
      await runBurnStep(liveCycle, step);
      const refreshed = await BuybackCycle.findById(cycleId).lean<BuybackCycleDoc | null>();
      if (!refreshed) {
        throw new Error(`buyback: cycle ${cycleId} vanished mid-pipeline`);
      }
      liveCycle = refreshed;
    }

    await BuybackCycle.updateOne(
      { _id: cycleId },
      { $set: { status: "COMPLETE" } },
    );

    await AuditLog.create({
      kind: "BUYBACK_CYCLE",
      actor: "buyback-worker",
      payload: {
        cycleId,
        admin,
        usdcAmount: cycle.usdcAmount,
        wfairAcquiredWei: wfairAcquired.toString(),
        burnAmountWei: shares.burn.toString(),
        treasuryAmountWei: shares.treasury.toString(),
        masternodeAmountWei: shares.masternode.toString(),
        swapTxHash: liveCycle.swapTxHash,
        burnTxHash: liveCycle.burnTxHash,
        treasuryTxHash: liveCycle.treasuryTxHash,
        masternodeTxHash: liveCycle.masternodeTxHash,
        destinations,
      },
    }).catch((err: unknown) => {
      logger.error({ err, cycleId }, "buyback: audit log write failed");
      return alert("buyback audit log write failed", { cycleId });
    });

    logger.info(
      {
        cycleId,
        usdcAmount: cycle.usdcAmount,
        wfairAcquiredWei: wfairAcquired.toString(),
      },
      "buyback: cycle complete",
    );

    const final = await BuybackCycle.findById(cycleId).lean<BuybackCycleDoc | null>();
    return final;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, cycleId }, "buyback: cycle error");
    // Only set FAILED if we haven't already (markFailed is called inside
    // specific revert paths). If the error is a transient RPC issue we leave
    // status at whatever step we're on and rely on the next tick to resume.
    // This matches the signer-level pattern: transient errors re-enter
    // reconciliation; permanent errors (revert) are terminal.
    const refreshed = await BuybackCycle.findById(cycleId).lean<BuybackCycleDoc | null>();
    if (refreshed && refreshed.status !== "FAILED" && refreshed.status !== "COMPLETE") {
      await alert("buyback cycle threw non-revert error — will retry next tick", {
        cycleId,
        message,
        status: refreshed.status,
      });
    }
    throw err;
  }
}

export async function startBuybackWorker(
  signal: AbortSignal,
  options: BuybackWorkerOptions = {},
): Promise<void> {
  if (!config.BUYBACK_ENABLED) {
    logger.info("buyback-worker disabled (BUYBACK_ENABLED=false)");
    return;
  }

  // Fail fast at boot if any required destination is missing / invalid.
  try {
    const destinations = resolveDestinations();
    await validateDestinations(destinations);
    logger.info({ destinations }, "buyback-worker starting");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "buyback-worker refusing to start");
    await alert("buyback-worker refused to start", { message });
    return;
  }

  const interval = options.intervalMs ?? config.BUYBACK_INTERVAL_MS;

  if (options.oneShot) {
    await runOneCycle().catch((err: unknown) => {
      logger.error({ err }, "buyback oneShot cycle failed");
    });
    return;
  }

  while (!signal.aborted) {
    try {
      await runOneCycle();
    } catch (err: unknown) {
      logger.error({ err }, "buyback-worker tick error");
    }
    await sleep(interval, signal);
  }
  logger.info("buyback-worker stopped");
}
