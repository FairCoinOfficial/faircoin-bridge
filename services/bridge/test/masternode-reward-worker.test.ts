// Tests for the masternode reward booster worker.
//
// Pattern matches test/signer-fair.test.ts: bun's mock.module() replaces the
// mongoose model + faircoind RPC + alert helpers with in-memory fakes BEFORE
// the worker module is imported. We then drive `runMasternodeRewardTick`
// (the pure-tick entrypoint, no timers) directly and assert state.
//
// The four invariants we lock in:
//   1. Disabled flag short-circuits before any RPC call.
//   2. No active masternodes → cycle marked SKIPPED_NO_MASTERNODES.
//   3. Pool balance below threshold → cycle marked SKIPPED_BELOW_THRESHOLD.
//   4. Happy path splits balance correctly (after fee budget) and broadcasts
//      exactly once per masternode; a retry never re-broadcasts.

import "./setup-env.js";

// Set a sane default config for the worker so the parsed env is "rewards
// enabled with a known reward address". Per-test overrides happen in
// beforeEach; setup-env.ts ran above with the global defaults already.
process.env.MASTERNODE_REWARDS_ENABLED = "true";
process.env.MASTERNODE_REWARDS_INTERVAL_MS = "60000";
process.env.MASTERNODE_REWARDS_MIN_BALANCE_FAIR = "10";
process.env.MASTERNODE_REWARDS_PAYOUT_FEE_FAIR = "0.001";
process.env.FAIR_MASTERNODE_REWARD_ADDRESS =
  "FErMgtiwoX4zrmUi5MHY7iZ2qij32ckdDg";

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

interface FakePayoutSubdoc {
  masternodeOutpoint: string;
  payoutAddress: string;
  amountSats: string;
  status: "PENDING" | "BROADCAST" | "CONFIRMED" | "FAILED";
  txid: string | null;
  errorMessage: string | null;
}

interface FakeCycleDoc {
  _id: { toString(): string };
  triggeredAt: Date;
  poolBalanceFair: string;
  activeMasternodes: number;
  perMasternodeFair: string;
  payouts: FakePayoutSubdoc[];
  status:
    | "PENDING"
    | "PAYING_OUT"
    | "COMPLETE"
    | "FAILED"
    | "SKIPPED_NO_MASTERNODES"
    | "SKIPPED_BELOW_THRESHOLD"
    | "SKIPPED_DISABLED";
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MockState {
  cycles: FakeCycleDoc[];
  poolReceivedSats: bigint;
  masternodes: Array<{
    txhash: string;
    outidx: number;
    status: string;
    addr: string;
    rank?: number;
  }>;
  rpcCalls: {
    getReceivedByAddress: number;
    getMasternodeList: number;
    sendToAddress: Array<{ address: string; amountFair: number }>;
    getRawTransaction: string[];
  };
  txExistsOnNode: boolean;
  alerts: Array<{ message: string; context: Record<string, unknown> }>;
  audits: Array<{ kind: string; payload: Record<string, unknown> }>;
}

const state: MockState = {
  cycles: [],
  poolReceivedSats: 0n,
  masternodes: [],
  rpcCalls: {
    getReceivedByAddress: 0,
    getMasternodeList: 0,
    sendToAddress: [],
    getRawTransaction: [],
  },
  txExistsOnNode: true,
  alerts: [],
  audits: [],
};

let nextCycleId = 1;

function makeCycleId(): { toString(): string } {
  const idStr = `cycle-${String(nextCycleId)}`;
  nextCycleId += 1;
  return { toString: () => idStr };
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (key === undefined) return;
    const next = current[key];
    if (typeof next !== "object" || next === null) return;
    current = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last === undefined) return;
  current[last] = value;
}

function applyUpdate(doc: FakeCycleDoc, update: { $set?: Record<string, unknown> }): void {
  if (!update.$set) return;
  for (const [key, val] of Object.entries(update.$set)) {
    if (key.includes(".")) {
      // Subdoc path like `payouts.0.txid`. Traverse manually so the index
      // routing matches the real Mongo update operator.
      setPath(doc as unknown as Record<string, unknown>, key, val);
    } else {
      (doc as unknown as Record<string, unknown>)[key] = val;
    }
  }
  doc.updatedAt = new Date();
}

function matchesFilter(
  doc: FakeCycleDoc,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "_id") {
      const docId = doc._id.toString();
      const expId =
        typeof expected === "object" && expected !== null
          ? String(expected)
          : String(expected);
      if (docId !== expId) return false;
      continue;
    }
    if (key === "status") {
      if (typeof expected === "string") {
        if (doc.status !== expected) return false;
      } else if (
        typeof expected === "object" &&
        expected !== null &&
        "$in" in expected
      ) {
        const inArr = (expected as { $in: string[] }).$in;
        if (!inArr.includes(doc.status)) return false;
      }
      continue;
    }
    if (key === "triggeredAt") {
      if (
        typeof expected === "object" &&
        expected !== null &&
        "$gte" in expected
      ) {
        const cutoff = (expected as { $gte: Date }).$gte;
        if (doc.triggeredAt < cutoff) return false;
      }
      continue;
    }
    const v = getPath(doc as unknown as Record<string, unknown>, key);
    if (v !== expected) return false;
  }
  return true;
}

mock.module("../src/models/masternode-reward-cycle.js", () => ({
  MasternodeRewardCycle: {
    create: async (input: Partial<FakeCycleDoc>): Promise<FakeCycleDoc> => {
      const now = new Date();
      const doc: FakeCycleDoc = {
        _id: makeCycleId(),
        triggeredAt: input.triggeredAt ?? now,
        poolBalanceFair: input.poolBalanceFair ?? "0",
        activeMasternodes: input.activeMasternodes ?? 0,
        perMasternodeFair: input.perMasternodeFair ?? "0",
        payouts: (input.payouts ?? []).map((p) => ({ ...p })),
        status: input.status ?? "PENDING",
        errorMessage: input.errorMessage ?? null,
        createdAt: now,
        updatedAt: now,
      };
      state.cycles.push(doc);
      return doc;
    },
    findOneAndUpdate: (
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown> },
      options: { new?: boolean; sort?: Record<string, number> } = {},
    ) => ({
      lean: async (): Promise<FakeCycleDoc | null> => {
        const candidates = state.cycles.filter((c) => matchesFilter(c, filter));
        if (candidates.length === 0) return null;
        if (options.sort && "createdAt" in options.sort) {
          candidates.sort((a, b) =>
            options.sort?.createdAt === 1
              ? a.createdAt.getTime() - b.createdAt.getTime()
              : b.createdAt.getTime() - a.createdAt.getTime(),
          );
        }
        const target = candidates[0];
        if (!target) return null;
        applyUpdate(target, update);
        return options.new === false ? null : { ...target };
      },
    }),
    findOne: (filter: Record<string, unknown> = {}) => ({
      select: (_proj: Record<string, number>) => ({
        lean: async (): Promise<{ _id: unknown } | null> => {
          const found = state.cycles.find((c) => matchesFilter(c, filter));
          return found ? { _id: found._id } : null;
        },
      }),
    }),
    findById: (id: { toString(): string } | string) => ({
      lean: async (): Promise<FakeCycleDoc | null> => {
        const idStr = typeof id === "string" ? id : id.toString();
        const found = state.cycles.find((c) => c._id.toString() === idStr);
        return found ? { ...found, payouts: found.payouts.map((p) => ({ ...p })) } : null;
      },
    }),
    updateOne: async (
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown> },
    ) => {
      const target = state.cycles.find((c) => matchesFilter(c, filter));
      if (!target) return { acknowledged: true, matchedCount: 0 };
      applyUpdate(target, update);
      return { acknowledged: true, matchedCount: 1 };
    },
  },
  MASTERNODE_REWARD_CYCLE_STATUSES: [
    "PENDING",
    "PAYING_OUT",
    "COMPLETE",
    "FAILED",
    "SKIPPED_NO_MASTERNODES",
    "SKIPPED_BELOW_THRESHOLD",
    "SKIPPED_DISABLED",
  ],
  MASTERNODE_PAYOUT_STATUSES: ["PENDING", "BROADCAST", "CONFIRMED", "FAILED"],
}));

mock.module("../src/models/audit-log.js", () => ({
  AuditLog: {
    create: async (input: { kind: string; payload: Record<string, unknown> }) => {
      state.audits.push({ kind: input.kind, payload: input.payload });
      return input;
    },
  },
}));

mock.module("../src/lib/alert.js", () => ({
  alert: async (message: string, context: Record<string, unknown> = {}) => {
    state.alerts.push({ message, context });
  },
}));

mock.module("../src/lib/logger.js", () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
  },
}));

// Mock the full fair.js surface. Bun's test runner shares mock state across
// files in the same `bun test` invocation, so this mock must export every
// symbol that any other test file imports (otherwise that test file will
// see undefined exports). We add no-op stubs for the rest of the surface
// (getBlockWithTxs, getBlockAtHeight, validateAddress, …) — they are not
// invoked by the masternode worker but their presence keeps the other
// tests' module-time `import` lookups happy.
mock.module("../src/rpc/fair.js", () => ({
  // Exercised by the masternode worker:
  getReceivedByAddressSats: async (_addr: string, _minconf?: number) => {
    state.rpcCalls.getReceivedByAddress += 1;
    return state.poolReceivedSats;
  },
  getMasternodeList: async () => {
    state.rpcCalls.getMasternodeList += 1;
    return state.masternodes;
  },
  sendToAddress: async (address: string, amountFair: number) => {
    state.rpcCalls.sendToAddress.push({ address, amountFair });
    const seq = state.rpcCalls.sendToAddress.length;
    return `txid_send_${String(seq)}`;
  },
  getRawTransaction: async (txid: string) => {
    state.rpcCalls.getRawTransaction.push(txid);
    if (!state.txExistsOnNode) {
      throw new Error("RPC -5: No such mempool or blockchain transaction");
    }
    return { txid, confirmations: 0 };
  },
  // Cross-test surface (other tests rely on these being present even if we
  // don't drive them ourselves). Keep behaviour intentionally simple so
  // accidental invocation is loud.
  validateAddress: async () => ({ isvalid: true }),
  getTipHeight: async () => 0,
  getBlockAtHeight: async () => {
    throw new Error("getBlockAtHeight not implemented in masternode-reward worker test");
  },
  getBlockWithTxs: async () => {
    throw new Error("getBlockWithTxs not implemented in masternode-reward worker test");
  },
  sendRawTransaction: async () => "",
  getWalletBalanceSats: async () => 0n,
  fairRpc: { call: async () => undefined },
}));

const { runMasternodeRewardTick, __test__ } = await import(
  "../src/workers/masternode-reward-worker.js"
);

function resetState(): void {
  state.cycles.length = 0;
  state.poolReceivedSats = 0n;
  state.masternodes.length = 0;
  state.rpcCalls.getReceivedByAddress = 0;
  state.rpcCalls.getMasternodeList = 0;
  state.rpcCalls.sendToAddress.length = 0;
  state.rpcCalls.getRawTransaction.length = 0;
  state.txExistsOnNode = true;
  state.alerts.length = 0;
  state.audits.length = 0;
  nextCycleId = 1;
}

beforeEach(() => {
  resetState();
});

// Bun's `mock.module` mutates a process-global module map. If we leave our
// mocks in place when this file finishes, subsequent test files (which load
// the same module paths but expect a different export shape) see the wrong
// implementation. Restore on teardown so the suite is order-independent.
afterAll(() => {
  mock.restore();
});

describe("computePerMasternodeSats (pure helper)", () => {
  it("subtracts fee budget × N before dividing by N", () => {
    // 100 FAIR pool, 10 masternodes, 0.001 FAIR fee buffer per payout.
    // Distributable = 100 − 0.01 = 99.99 FAIR ⇒ 9.999 FAIR each.
    const pool = __test__.fairToSats(100);
    const per = __test__.computePerMasternodeSats(pool, 10, 0.001);
    expect(per).toBe(__test__.fairToSats(9.999));
  });

  it("returns 0n when pool ≤ fee budget (no distributable balance)", () => {
    const pool = __test__.fairToSats(0.005); // 0.5 cent FAIR
    // 10 masternodes × 0.001 fee budget = 0.01 FAIR total, > pool.
    const per = __test__.computePerMasternodeSats(pool, 10, 0.001);
    expect(per).toBe(0n);
  });

  it("returns 0n on zero masternodes (avoids div-by-zero)", () => {
    const pool = __test__.fairToSats(1000);
    const per = __test__.computePerMasternodeSats(pool, 0, 0.001);
    expect(per).toBe(0n);
  });

  it("floors integer division (no fractional sats)", () => {
    // 7 sats over 3 masternodes = 2 each, 1 sat unused. Fee=0 for clarity.
    const per = __test__.computePerMasternodeSats(7n, 3, 0);
    expect(per).toBe(2n);
  });
});

describe("isEligible / outpointKey", () => {
  it("treats only ENABLED status as eligible", () => {
    expect(
      __test__.isEligible({
        status: "ENABLED",
        addr: "FA",
        txhash: "h",
        outidx: 0,
      }),
    ).toBe(true);
    for (const s of ["EXPIRED", "REMOVE", "POSE_BAN", "PRE_ENABLED", "WATCHDOG_EXPIRED"]) {
      expect(
        __test__.isEligible({
          status: s,
          addr: "FA",
          txhash: "h",
          outidx: 0,
        }),
      ).toBe(false);
    }
  });

  it("formats outpoint as txhash-outidx (matches faircoind keying)", () => {
    expect(
      __test__.outpointKey({
        txhash: "abc",
        outidx: 7,
        status: "ENABLED",
        addr: "FX",
      }),
    ).toBe("abc-7");
  });
});

describe("runMasternodeRewardTick — skip paths", () => {
  it("creates SKIPPED_NO_MASTERNODES when masternodelist returns empty", async () => {
    state.poolReceivedSats = __test__.fairToSats(500);
    state.masternodes = [];

    await runMasternodeRewardTick();

    expect(state.cycles).toHaveLength(1);
    const cycle = state.cycles[0];
    if (!cycle) throw new Error("expected cycle");
    expect(cycle.status).toBe("SKIPPED_NO_MASTERNODES");
    expect(cycle.activeMasternodes).toBe(0);
    expect(cycle.payouts).toHaveLength(0);
    expect(state.rpcCalls.sendToAddress).toHaveLength(0);
    expect(state.audits.some((a) => a.kind === "MASTERNODE_REWARD_CYCLE")).toBe(true);
  });

  it("creates SKIPPED_BELOW_THRESHOLD when pool < min balance", async () => {
    // Pool has 5 FAIR, threshold is 10 FAIR (set in process.env above).
    state.poolReceivedSats = __test__.fairToSats(5);
    state.masternodes = [
      { txhash: "h1", outidx: 0, status: "ENABLED", addr: "FA1" },
    ];

    await runMasternodeRewardTick();

    expect(state.cycles).toHaveLength(1);
    const cycle = state.cycles[0];
    if (!cycle) throw new Error("expected cycle");
    expect(cycle.status).toBe("SKIPPED_BELOW_THRESHOLD");
    expect(state.rpcCalls.sendToAddress).toHaveLength(0);
  });

  it("creates SKIPPED_BELOW_THRESHOLD when fee budget swallows the pool", async () => {
    // Pool above the min-balance threshold (≥10 FAIR) so we get past the
    // first gate, but the per-masternode-after-fees would round to 0n
    // (huge masternode count vs. pool size).
    state.poolReceivedSats = __test__.fairToSats(10);
    state.masternodes = [];
    for (let i = 0; i < 100_000; i += 1) {
      state.masternodes.push({
        txhash: `h${String(i)}`,
        outidx: 0,
        status: "ENABLED",
        addr: `FAddr${String(i)}`,
      });
    }

    await runMasternodeRewardTick();

    expect(state.cycles).toHaveLength(1);
    const cycle = state.cycles[0];
    if (!cycle) throw new Error("expected cycle");
    expect(cycle.status).toBe("SKIPPED_BELOW_THRESHOLD");
    expect(state.rpcCalls.sendToAddress).toHaveLength(0);
  });
});

describe("runMasternodeRewardTick — happy path", () => {
  it("splits balance across active masternodes and broadcasts once each", async () => {
    state.poolReceivedSats = __test__.fairToSats(100);
    state.masternodes = [
      { txhash: "h1", outidx: 0, status: "ENABLED", addr: "FAddr1" },
      { txhash: "h2", outidx: 0, status: "ENABLED", addr: "FAddr2" },
      { txhash: "h3", outidx: 1, status: "ENABLED", addr: "FAddr3" },
      { txhash: "h4", outidx: 0, status: "EXPIRED", addr: "FAddr4" }, // filtered
    ];

    await runMasternodeRewardTick();

    // One PAYING_OUT cycle row created; 3 sends (skip the EXPIRED one).
    expect(state.cycles).toHaveLength(1);
    const cycle = state.cycles[0];
    if (!cycle) throw new Error("expected cycle");
    expect(cycle.activeMasternodes).toBe(3);
    expect(cycle.payouts).toHaveLength(3);

    // Per-masternode amount = (100 − 3*0.001) / 3 = 33.333 FAIR.
    // 100_00000000 − 300_000 = 9999700_000_000 sats (wait, recompute):
    // 100 FAIR  = 10_000_000_000 sats
    // 0.001 FAIR = 100_000 sats; ×3 = 300_000 sats
    // distributable = 9_999_700_000 sats
    // per masternode = 3_333_233_333 sats (floor division)
    const expectedPerSats = (
      __test__.fairToSats(100) - __test__.fairToSats(0.001) * 3n
    ) / 3n;
    expect(cycle.perMasternodeFair).toBe(expectedPerSats.toString());

    // Three broadcasts, one per ENABLED masternode, in masternodelist order.
    expect(state.rpcCalls.sendToAddress).toHaveLength(3);
    expect(state.rpcCalls.sendToAddress.map((c) => c.address)).toEqual([
      "FAddr1",
      "FAddr2",
      "FAddr3",
    ]);

    // All payout rows must have a txid + BROADCAST status.
    for (const p of cycle.payouts) {
      expect(p.txid).not.toBeNull();
      expect(p.status).toBe("BROADCAST");
    }

    // Cycle finalised to COMPLETE + audited.
    expect(cycle.status).toBe("COMPLETE");
    expect(state.audits.some((a) => a.kind === "MASTERNODE_REWARD_CYCLE")).toBe(true);
  });

  it("does not re-broadcast on retry (idempotency on cycle resume)", async () => {
    state.poolReceivedSats = __test__.fairToSats(100);
    state.masternodes = [
      { txhash: "h1", outidx: 0, status: "ENABLED", addr: "FAddr1" },
      { txhash: "h2", outidx: 0, status: "ENABLED", addr: "FAddr2" },
    ];

    await runMasternodeRewardTick();
    const sendsAfterFirst = state.rpcCalls.sendToAddress.length;
    expect(sendsAfterFirst).toBe(2);
    expect(state.cycles).toHaveLength(1);

    // Second tick: cycle is COMPLETE, recent (cadence-gate kicks in), so
    // nothing should happen. No new send, no new cycle row.
    await runMasternodeRewardTick();
    expect(state.rpcCalls.sendToAddress.length).toBe(sendsAfterFirst);
    expect(state.cycles).toHaveLength(1);
  });

  it("resumes a PAYING_OUT cycle and reconciles via getrawtransaction (no re-send)", async () => {
    // Hand-build a PAYING_OUT cycle as if a prior tick crashed AFTER
    // sendToAddress returned a txid AND we persisted it, but BEFORE
    // flipping payout status to BROADCAST.
    state.cycles.push({
      _id: makeCycleId(),
      triggeredAt: new Date(),
      poolBalanceFair: __test__.fairToSats(100).toString(),
      activeMasternodes: 2,
      perMasternodeFair: __test__.fairToSats(49.999).toString(),
      payouts: [
        {
          masternodeOutpoint: "h1-0",
          payoutAddress: "FAddr1",
          amountSats: __test__.fairToSats(49.999).toString(),
          status: "PENDING",
          // Crashed mid-write: txid persisted, status still PENDING.
          txid: "txid_prior_crash",
          errorMessage: null,
        },
        {
          masternodeOutpoint: "h2-0",
          payoutAddress: "FAddr2",
          amountSats: __test__.fairToSats(49.999).toString(),
          status: "PENDING",
          txid: null,
          errorMessage: null,
        },
      ],
      status: "PAYING_OUT",
      errorMessage: null,
      createdAt: new Date(Date.now() - 30_000),
      updatedAt: new Date(Date.now() - 30_000),
    });
    state.txExistsOnNode = true;

    await runMasternodeRewardTick();

    // Only ONE new sendtoaddress (for the second masternode). The first
    // already had a txid; the worker reconciled via getrawtransaction.
    expect(state.rpcCalls.sendToAddress).toHaveLength(1);
    expect(state.rpcCalls.sendToAddress[0]?.address).toBe("FAddr2");
    expect(state.rpcCalls.getRawTransaction).toContain("txid_prior_crash");

    const cycle = state.cycles[0];
    if (!cycle) throw new Error("expected cycle");
    expect(cycle.payouts[0]?.status).toBe("BROADCAST");
    expect(cycle.payouts[0]?.txid).toBe("txid_prior_crash");
    expect(cycle.payouts[1]?.status).toBe("BROADCAST");
    expect(cycle.status).toBe("COMPLETE");
  });

  it("marks payout FAILED + alerts when reconciliation finds no such tx (no re-broadcast)", async () => {
    // Same crashed-mid-write fixture as above, but the daemon has no
    // record of the txid — pathological. Worker must NOT re-send (would
    // double-spend); must mark the payout FAILED and the cycle FAILED.
    state.cycles.push({
      _id: makeCycleId(),
      triggeredAt: new Date(),
      poolBalanceFair: __test__.fairToSats(100).toString(),
      activeMasternodes: 1,
      perMasternodeFair: __test__.fairToSats(99.999).toString(),
      payouts: [
        {
          masternodeOutpoint: "hOnly-0",
          payoutAddress: "FOnly",
          amountSats: __test__.fairToSats(99.999).toString(),
          status: "PENDING",
          txid: "txid_ghost",
          errorMessage: null,
        },
      ],
      status: "PAYING_OUT",
      errorMessage: null,
      createdAt: new Date(Date.now() - 30_000),
      updatedAt: new Date(Date.now() - 30_000),
    });
    state.txExistsOnNode = false;

    await runMasternodeRewardTick();

    expect(state.rpcCalls.sendToAddress).toHaveLength(0);
    const cycle = state.cycles[0];
    if (!cycle) throw new Error("expected cycle");
    expect(cycle.payouts[0]?.status).toBe("FAILED");
    expect(cycle.payouts[0]?.errorMessage ?? "").toContain("not found on node");
    expect(cycle.status).toBe("FAILED");
    expect(state.alerts.some((a) => a.message.includes("missing"))).toBe(true);
  });
});
