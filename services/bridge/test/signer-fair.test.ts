// Idempotency contract for the FAIR release signer.
//
// `sendToAddress` is the only non-idempotent side-effect in this service:
// each call broadcasts a new transaction with new inputs. A retry that
// re-invokes it would double-spend the user's withdrawal. The signer must
// persist the returned txid before any further state transition and must
// reconcile via getrawtransaction on retry instead of re-broadcasting.

import "./setup-env.js";

import { beforeEach, describe, expect, it, mock } from "bun:test";

interface FakeWithdrawalDoc {
  _id: { toString(): string };
  status: string;
  fairTxid: string | null;
  fairBroadcastAt: Date | null;
  destinationFairAddress: string;
}

interface ReleaseCounters {
  sendToAddress: number;
  getRawTransaction: number;
  validateAddress: number;
}

let withdrawalDoc: FakeWithdrawalDoc;
let counters: ReleaseCounters;
let txExistsOnNode = true;

function matchesStatusFilter(
  doc: FakeWithdrawalDoc,
  filter: { status?: { $in?: string[] } | string },
): boolean {
  const s = filter.status;
  if (!s) return true;
  if (typeof s === "string") return doc.status === s;
  if (s.$in) return s.$in.includes(doc.status);
  return true;
}

function applySet(
  doc: FakeWithdrawalDoc,
  update: { $set?: Partial<FakeWithdrawalDoc> },
): void {
  if (!update.$set) return;
  Object.assign(doc, update.$set);
}

mock.module("../src/models/withdrawal.js", () => ({
  Withdrawal: {
    findById: (id: string) => ({
      lean: async (): Promise<FakeWithdrawalDoc | null> =>
        withdrawalDoc._id.toString() === id ? { ...withdrawalDoc } : null,
    }),
    findOneAndUpdate: (
      filter: {
        _id?: string;
        status?: { $in?: string[] };
        fairTxid?: null;
      },
      update: { $set?: Partial<FakeWithdrawalDoc> },
    ) => ({
      lean: async (): Promise<FakeWithdrawalDoc | null> => {
        if (filter._id && withdrawalDoc._id.toString() !== filter._id)
          return null;
        if (!matchesStatusFilter(withdrawalDoc, filter)) return null;
        if (
          "fairTxid" in filter &&
          filter.fairTxid === null &&
          withdrawalDoc.fairTxid !== null
        )
          return null;
        applySet(withdrawalDoc, update);
        return { ...withdrawalDoc };
      },
    }),
    updateOne: async (
      _filter: unknown,
      update: { $set?: Partial<FakeWithdrawalDoc> },
    ) => {
      applySet(withdrawalDoc, update);
      return { acknowledged: true };
    },
  },
}));

mock.module("../src/models/audit-log.js", () => ({
  AuditLog: { create: async () => ({}) },
}));

mock.module("../src/lib/alert.js", () => ({
  alert: async () => undefined,
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

mock.module("../src/rpc/fair.js", () => ({
  validateAddress: async () => {
    counters.validateAddress += 1;
    return { isvalid: true };
  },
  sendToAddress: async (): Promise<string> => {
    counters.sendToAddress += 1;
    return "fairtxid_broadcast_one";
  },
  getRawTransaction: async (): Promise<unknown> => {
    counters.getRawTransaction += 1;
    if (!txExistsOnNode) {
      throw new Error("RPC -5: No such mempool or blockchain transaction");
    }
    return { txid: "fairtxid_broadcast_one", confirmations: 0 };
  },
}));

const { signRelease } = await import("../src/signer/fair.js");

const job = {
  withdrawalId: "withdrawal-123",
  destinationFairAddress: "fT1abcdefghijklmnopqrstuvwxyz1",
  amountSats: "1000000000",
  baseBurnTxHash:
    "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  logIndex: 0,
};

beforeEach(() => {
  withdrawalDoc = {
    _id: { toString: () => "withdrawal-123" },
    status: "CONFIRMED",
    fairTxid: null,
    fairBroadcastAt: null,
    destinationFairAddress: job.destinationFairAddress,
  };
  counters = { sendToAddress: 0, getRawTransaction: 0, validateAddress: 0 };
  txExistsOnNode = true;
});

describe("signRelease idempotency (node_wallet)", () => {
  it("broadcasts exactly once on a happy-path single call", async () => {
    await signRelease(job);
    expect(counters.sendToAddress).toBe(1);
    expect(withdrawalDoc.status).toBe("BROADCAST");
    expect(withdrawalDoc.fairTxid).toBe("fairtxid_broadcast_one");
  });

  it("broadcasts exactly once when the job is retried after success", async () => {
    await signRelease(job);
    expect(counters.sendToAddress).toBe(1);
    // Retry: status is BROADCAST, short-circuits at the top.
    await signRelease(job);
    expect(counters.sendToAddress).toBe(1);
  });

  it("does not re-send if a prior attempt left a txid in SIGNING state", async () => {
    // Simulate a crash AFTER sendToAddress returned and the txid was
    // persisted, but BEFORE the status update completed.
    withdrawalDoc.status = "SIGNING";
    withdrawalDoc.fairTxid = "fairtxid_broadcast_one";

    await signRelease(job);

    expect(counters.sendToAddress).toBe(0);
    expect(counters.getRawTransaction).toBeGreaterThanOrEqual(1);
    expect(withdrawalDoc.status).toBe("BROADCAST");
    expect(withdrawalDoc.fairTxid).toBe("fairtxid_broadcast_one");
  });

  it("fails closed if a stored txid is missing from the node — never re-broadcasts", async () => {
    // Pathological: txid persisted but the node has no record. Re-sending
    // would create a different tx with potentially conflicting inputs and
    // double-spend the withdrawal. The signer must throw, never call
    // sendToAddress.
    withdrawalDoc.status = "SIGNING";
    withdrawalDoc.fairTxid = "fairtxid_broadcast_one";
    txExistsOnNode = false;

    await expect(signRelease(job)).rejects.toThrow(/no such tx|RPC -5/i);
    expect(counters.sendToAddress).toBe(0);
  });

  it("refuses to retry a FAILED withdrawal (NonRetryableError)", async () => {
    withdrawalDoc.status = "FAILED";
    await expect(signRelease(job)).rejects.toThrow(/FAILED/);
    expect(counters.sendToAddress).toBe(0);
  });
});
