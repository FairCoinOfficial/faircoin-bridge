// Idempotency contract for the WFAIR mint signer.
//
// What we're protecting against: any path that lets a single deposit row
// produce more than one on-chain mint tx. The signer is invoked by a BullMQ
// worker that retries on failure, so any partial state — process crash mid-
// broadcast, RPC timeout after writeContract returned, hot-reload during a
// receipt wait — must be safe to resume without re-broadcasting.
//
// Strategy: replace the model + viem client with in-memory fakes, then
// invoke signMint twice for the same deposit. Assert exactly one
// writeContract call regardless of when the simulated crash happens.

import "./setup-env.js";

import { beforeEach, describe, expect, it, mock } from "bun:test";

interface FakeDepositDoc {
  _id: { toString(): string };
  status: string;
  baseMintTxHash: string | null;
  safeTxHash: string | null;
  baseMintBlockNumber: number | null;
}

interface MintCounters {
  writeContract: number;
  waitReceipt: number;
}

let depositDoc: FakeDepositDoc;
let counters: MintCounters;
let receiptResolver: (
  value: { status: "success" | "reverted"; blockNumber: bigint },
) => void;
let receiptPromise: Promise<{
  status: "success" | "reverted";
  blockNumber: bigint;
}>;
let pendingReceipt = false;

function newReceiptPromise(): void {
  receiptPromise = new Promise((resolve) => {
    receiptResolver = resolve;
  });
}

function matchesStatusFilter(
  doc: FakeDepositDoc,
  filter: { status?: { $in?: string[] } | string },
): boolean {
  const s = filter.status;
  if (!s) return true;
  if (typeof s === "string") return doc.status === s;
  if (s.$in) return s.$in.includes(doc.status);
  return true;
}

function matchesNullFilter(
  doc: FakeDepositDoc,
  filter: Record<string, unknown>,
  key: "baseMintTxHash" | "safeTxHash",
): boolean {
  if (!(key in filter)) return true;
  return filter[key] === null && doc[key] === null;
}

function applySet(
  doc: FakeDepositDoc,
  update: { $set?: Partial<FakeDepositDoc> },
): void {
  if (!update.$set) return;
  Object.assign(doc, update.$set);
}

mock.module("../src/models/deposit.js", () => ({
  Deposit: {
    findById: (id: string) => ({
      lean: async (): Promise<FakeDepositDoc | null> =>
        depositDoc._id.toString() === id ? { ...depositDoc } : null,
    }),
    findOneAndUpdate: (
      filter: {
        _id?: string;
        status?: { $in?: string[] };
        baseMintTxHash?: null;
        safeTxHash?: null;
      },
      update: { $set?: Partial<FakeDepositDoc> },
    ) => ({
      lean: async (): Promise<FakeDepositDoc | null> => {
        if (filter._id && depositDoc._id.toString() !== filter._id) return null;
        if (!matchesStatusFilter(depositDoc, filter)) return null;
        if (!matchesNullFilter(depositDoc, filter, "baseMintTxHash"))
          return null;
        if (!matchesNullFilter(depositDoc, filter, "safeTxHash")) return null;
        applySet(depositDoc, update);
        return { ...depositDoc };
      },
    }),
    updateOne: async (
      _filter: unknown,
      update: { $set?: Partial<FakeDepositDoc> },
    ) => {
      applySet(depositDoc, update);
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

mock.module("../src/rpc/base.js", () => {
  const requireWallet = () => ({
    account: { address: "0x000000000000000000000000000000000000dead" },
    writeContract: async (): Promise<`0x${string}`> => {
      counters.writeContract += 1;
      return "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface" as `0x${string}`;
    },
  });
  const basePublic = {
    waitForTransactionReceipt: async (): Promise<{
      status: "success" | "reverted";
      blockNumber: bigint;
    }> => {
      counters.waitReceipt += 1;
      if (pendingReceipt) {
        pendingReceipt = false;
        return await receiptPromise;
      }
      return { status: "success" as const, blockNumber: 1n };
    },
  };
  return {
    requireWallet,
    basePublic,
    baseChain: { id: 84532 },
  };
});

const { signMint } = await import("../src/signer/base.js");

const job = {
  depositId: "deposit-123",
  baseAddress: "0x000000000000000000000000000000000000beef",
  amountWei: "10000000000000000000",
  fairTxid:
    "0000000000000000000000000000000000000000000000000000000000000001",
  fairVout: 0,
};

beforeEach(() => {
  depositDoc = {
    _id: { toString: () => "deposit-123" },
    status: "CONFIRMED",
    baseMintTxHash: null,
    safeTxHash: null,
    baseMintBlockNumber: null,
  };
  counters = { writeContract: 0, waitReceipt: 0 };
  pendingReceipt = false;
  newReceiptPromise();
});

describe("signMint idempotency (direct_eoa)", () => {
  it("broadcasts exactly once on a happy-path single call", async () => {
    await signMint(job);
    expect(counters.writeContract).toBe(1);
    expect(depositDoc.status).toBe("MINTED");
    expect(depositDoc.baseMintTxHash).not.toBeNull();
  });

  it("broadcasts exactly once when the job is retried after success", async () => {
    await signMint(job);
    expect(counters.writeContract).toBe(1);
    // Retry: already MINTED short-circuits at the top.
    await signMint(job);
    expect(counters.writeContract).toBe(1);
  });

  it("does not re-broadcast if a prior attempt left a tx hash in MINTING state", async () => {
    // Simulate a crash AFTER writeContract returned and the hash was
    // persisted, but BEFORE waitForTransactionReceipt resolved.
    depositDoc.status = "MINTING";
    depositDoc.baseMintTxHash =
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    await signMint(job);

    // The signer must reconcile by waiting on the existing hash, not
    // broadcast a fresh tx.
    expect(counters.writeContract).toBe(0);
    expect(counters.waitReceipt).toBeGreaterThanOrEqual(1);
    expect(depositDoc.status).toBe("MINTED");
    expect(depositDoc.baseMintTxHash).toBe(
      "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
  });

  it("refuses to retry a FAILED deposit (NonRetryableError)", async () => {
    depositDoc.status = "FAILED";
    await expect(signMint(job)).rejects.toThrow(/FAILED/);
    expect(counters.writeContract).toBe(0);
  });
});
