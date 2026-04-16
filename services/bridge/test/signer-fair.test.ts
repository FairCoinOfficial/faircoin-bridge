// Idempotency contract for the FAIR release signer.
//
// `sendToAddress` is the only non-idempotent side-effect in this service:
// each call broadcasts a new transaction with new inputs. A retry that
// re-invokes it would double-spend the user's withdrawal. The signer must
// persist the returned txid before any further state transition and must
// reconcile via getrawtransaction on retry instead of re-broadcasting.

import "./setup-env.js";

// Shared FaircoinRpcClient mock (see test/mock-fair-rpc.ts). We dispatch
// the few RPC calls the signer makes (`validateaddress`, `sendtoaddress`,
// `getrawtransaction`) through the runtime-mutable handler so this file
// composes with the rest of the suite under bun's process-wide mock cache.
import { setRpcHandler, clearRpcHandler } from "./mock-fair-rpc.js";

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

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

mock.module("../src/models/buy-order.js", () => ({
  BuyOrder: {
    // No buy orders in the FAIR-signer test fixture. The signer's
    // linkReleaseToBuyOrder helper calls findOneAndUpdate.lean(), so return
    // a chainable that resolves to null without touching the mongo driver.
    findOneAndUpdate: () => ({
      lean: async (): Promise<null> => null,
    }),
  },
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

// Route fair.ts through the shared FaircoinRpcClient mock by handler. We
// also need to keep `validateaddress` answering with the schema-shaped
// `{isvalid, address}` blob (validateAddress in fair.ts parses the raw
// response with zod).
function signerRpcHandler(
  method: string,
  _params: readonly unknown[],
): Promise<unknown> {
  switch (method) {
    case "validateaddress":
      counters.validateAddress += 1;
      return Promise.resolve({ isvalid: true });
    case "sendtoaddress":
      counters.sendToAddress += 1;
      return Promise.resolve("fairtxid_broadcast_one");
    case "getrawtransaction":
      counters.getRawTransaction += 1;
      if (!txExistsOnNode) {
        return Promise.reject(
          new Error("RPC -5: No such mempool or blockchain transaction"),
        );
      }
      return Promise.resolve({
        txid: "fairtxid_broadcast_one",
        confirmations: 0,
      });
    default:
      return Promise.reject(
        new Error(`signer-fair test: unmocked RPC method ${method}`),
      );
  }
}

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
  setRpcHandler(signerRpcHandler);
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

afterAll(() => {
  // Clear shared mock handler + restore module spies (audit-log, alert,
  // logger). The dispatch class itself stays installed so later test files
  // composes cleanly under bun's process-wide mock cache.
  clearRpcHandler();
  mock.restore();
});
