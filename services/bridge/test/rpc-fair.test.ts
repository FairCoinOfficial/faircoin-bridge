// Wire tests for the faircoin v3 verbosity workaround in src/rpc/fair.ts.
//
// faircoin v3 (forked from a pre-Bitcoin-0.15 codebase) doesn't accept
// `getblock(hash, 2)` and doesn't accept `getrawtransaction(txid, true)`.
// `getBlockWithTxs` works around the daemon by:
//   1. calling `getblock(hash, true)` — boolean verbose, returns block with
//      `tx` as a string[] of txids
//   2. calling `getrawtransaction(txid, 1)` — numeric verbose — for each txid
//   3. merging the per-tx vouts back into the block shape callers expect
//
// We mock the FaircoinRpcClient to assert the exact RPC arguments faircoin v3
// requires (no boolean for getrawtransaction, no integer for getblock) and
// verify the merged shape.

import "./setup-env.js";

// Shared FaircoinRpcClient mock (see test/mock-fair-rpc.ts for rationale).
// We install the dispatch class here so fair.ts's `export const fairRpc`
// singleton is bound to it; per-test behaviour is configured by calling
// `setRpcHandler(...)` in each `it` block via the local helper below.
import { setRpcHandler, clearRpcHandler } from "./mock-fair-rpc.js";

import { afterAll, beforeEach, describe, expect, it } from "bun:test";

interface RpcCall {
  method: string;
  params: readonly unknown[];
}

interface RawBlockFixture {
  hash: string;
  height: number;
  confirmations: number;
  time: number;
  previousblockhash?: string;
  tx: string[];
}

interface RawTxFixture {
  hex?: string;
  txid: string;
  hash?: string;
  confirmations?: number;
  blockhash?: string;
  blocktime?: number;
  vout: Array<{
    value: number;
    n: number;
    scriptPubKey: {
      addresses?: string[];
      address?: string;
      type: string;
      asm: string;
      hex: string;
    };
  }>;
}

let calls: RpcCall[];
let blockHashByHeight: Map<number, string>;
let blockByHash: Map<string, RawBlockFixture>;
let txByTxid: Map<string, RawTxFixture | Error>;

function rpcHandler(
  method: string,
  params: readonly unknown[],
): Promise<unknown> {
  calls.push({ method, params });
  switch (method) {
    case "getblockhash": {
      const height = params[0];
      if (typeof height !== "number") {
        return Promise.reject(
          new Error("mock: getblockhash height must be a number"),
        );
      }
      const hash = blockHashByHeight.get(height);
      if (hash === undefined) {
        return Promise.reject(
          new Error(`mock: no block hash for height ${String(height)}`),
        );
      }
      return Promise.resolve(hash);
    }
    case "getblock": {
      // faircoin v3 contract: 2nd arg MUST be a boolean.
      if (typeof params[1] !== "boolean") {
        return Promise.reject(
          new Error(
            `mock: getblock 2nd arg must be boolean, got ${typeof params[1]}`,
          ),
        );
      }
      const hash = params[0];
      if (typeof hash !== "string") {
        return Promise.reject(
          new Error("mock: getblock hash must be a string"),
        );
      }
      const block = blockByHash.get(hash);
      if (!block) {
        return Promise.reject(
          new Error(`mock: no block fixture for hash ${hash}`),
        );
      }
      return Promise.resolve(block);
    }
    case "getrawtransaction": {
      // faircoin v3 contract: 2nd arg MUST be numeric.
      if (typeof params[1] !== "number") {
        return Promise.reject(
          new Error(
            `mock: getrawtransaction 2nd arg must be number, got ${typeof params[1]}`,
          ),
        );
      }
      const txid = params[0];
      if (typeof txid !== "string") {
        return Promise.reject(
          new Error("mock: getrawtransaction txid must be a string"),
        );
      }
      const fixture = txByTxid.get(txid);
      if (fixture === undefined) {
        return Promise.reject(
          new Error(`mock: no tx fixture for txid ${txid}`),
        );
      }
      if (fixture instanceof Error) return Promise.reject(fixture);
      return Promise.resolve(fixture);
    }
    default:
      return Promise.reject(new Error(`mock: unmocked RPC method ${method}`));
  }
}

const fairRpc = await import("../src/rpc/fair.js");

function makeRawTx(
  txid: string,
  vout: RawTxFixture["vout"],
  overrides: Partial<RawTxFixture> = {},
): RawTxFixture {
  return {
    txid,
    hash: txid,
    confirmations: 10,
    blockhash: "blockhash-default",
    blocktime: 1_700_000_000,
    vout,
    ...overrides,
  };
}

function makeCoinbaseTx(txid: string): RawTxFixture {
  return makeRawTx(txid, [
    {
      value: 10,
      n: 0,
      scriptPubKey: {
        addresses: ["FErMgtiwoX4zrmUi5MHY7iZ2qij32ckdDg"],
        type: "pubkeyhash",
        asm: "OP_DUP OP_HASH160 ... OP_EQUALVERIFY OP_CHECKSIG",
        hex: "76a914...88ac",
      },
    },
  ]);
}

beforeEach(() => {
  calls = [];
  blockHashByHeight = new Map();
  blockByHash = new Map();
  txByTxid = new Map();
  setRpcHandler(rpcHandler);
});

describe("getBlockWithTxs (faircoin v3 verbosity workaround)", () => {
  it("merges getblock(true) + getrawtransaction(1) into the BlockVerbose shape", async () => {
    const blockHash = "blockhash-4500";
    blockHashByHeight.set(4500, blockHash);
    blockByHash.set(blockHash, {
      hash: blockHash,
      height: 4500,
      confirmations: 182,
      time: 1_776_323_119,
      previousblockhash: "blockhash-4499",
      tx: ["txid-coinbase-4500"],
    });
    txByTxid.set("txid-coinbase-4500", makeCoinbaseTx("txid-coinbase-4500"));

    const block = await fairRpc.getBlockWithTxs(4500);

    expect(block.hash).toBe(blockHash);
    expect(block.height).toBe(4500);
    expect(block.confirmations).toBe(182);
    expect(block.previousblockhash).toBe("blockhash-4499");
    expect(block.tx).toHaveLength(1);
    const tx = block.tx[0];
    expect(tx).toBeDefined();
    if (!tx) throw new Error("tx[0] missing");
    expect(tx.txid).toBe("txid-coinbase-4500");
    expect(tx.vout).toHaveLength(1);
    const vout = tx.vout[0];
    expect(vout).toBeDefined();
    if (!vout) throw new Error("vout[0] missing");
    expect(vout.scriptPubKey.addresses).toEqual([
      "FErMgtiwoX4zrmUi5MHY7iZ2qij32ckdDg",
    ]);

    // Wire-call audit: faircoin v3 forbids boolean for getrawtransaction and
    // forbids integer for getblock. Both calls must use the correct primitive.
    const getblockCall = calls.find((c) => c.method === "getblock");
    expect(getblockCall).toBeDefined();
    if (!getblockCall) throw new Error("getblock not called");
    expect(getblockCall.params[0]).toBe(blockHash);
    expect(getblockCall.params[1]).toBe(true);
    expect(typeof getblockCall.params[1]).toBe("boolean");

    const grtCall = calls.find((c) => c.method === "getrawtransaction");
    expect(grtCall).toBeDefined();
    if (!grtCall) throw new Error("getrawtransaction not called");
    expect(grtCall.params[0]).toBe("txid-coinbase-4500");
    expect(grtCall.params[1]).toBe(1);
    expect(typeof grtCall.params[1]).toBe("number");
  });

  it("handles a block with multiple txs in input order", async () => {
    const blockHash = "blockhash-multi";
    const txids = ["tx-a", "tx-b", "tx-c", "tx-d", "tx-e", "tx-f", "tx-g"];
    blockHashByHeight.set(123, blockHash);
    blockByHash.set(blockHash, {
      hash: blockHash,
      height: 123,
      confirmations: 1,
      time: 1_776_000_000,
      tx: txids,
    });
    for (const txid of txids) {
      txByTxid.set(
        txid,
        makeRawTx(txid, [
          {
            value: 1,
            n: 0,
            scriptPubKey: {
              address: `addr-for-${txid}`,
              type: "pubkeyhash",
              asm: "asm",
              hex: "hex",
            },
          },
        ]),
      );
    }

    const block = await fairRpc.getBlockWithTxs(123);

    expect(block.tx.map((t) => t.txid)).toEqual(txids);
    // Confirm each vout was decoded and threaded back into the right slot.
    for (let i = 0; i < txids.length; i += 1) {
      const tx = block.tx[i];
      expect(tx).toBeDefined();
      if (!tx) throw new Error(`tx[${i}] missing`);
      const vout = tx.vout[0];
      expect(vout).toBeDefined();
      if (!vout) throw new Error(`tx[${i}].vout[0] missing`);
      expect(vout.scriptPubKey.address).toBe(`addr-for-${txids[i]}`);
    }
    // Concurrency cap (5) means we issue exactly N getrawtransaction calls,
    // one per txid, regardless of pool size. No duplicates, no skips.
    const grtCalls = calls.filter((c) => c.method === "getrawtransaction");
    expect(grtCalls).toHaveLength(txids.length);
  });

  it("returns an empty tx array when the block has no transactions", async () => {
    const blockHash = "blockhash-empty";
    blockHashByHeight.set(7, blockHash);
    blockByHash.set(blockHash, {
      hash: blockHash,
      height: 7,
      confirmations: 99,
      time: 1_776_000_000,
      tx: [],
    });

    const block = await fairRpc.getBlockWithTxs(7);

    expect(block.tx).toEqual([]);
    // No per-tx fetches when the block is empty.
    expect(calls.filter((c) => c.method === "getrawtransaction")).toHaveLength(
      0,
    );
  });

  it("propagates an error when any per-tx fetch fails (no partial block)", async () => {
    const blockHash = "blockhash-bad-tx";
    const txids = ["tx-good-1", "tx-bad", "tx-good-2"];
    blockHashByHeight.set(99, blockHash);
    blockByHash.set(blockHash, {
      hash: blockHash,
      height: 99,
      confirmations: 1,
      time: 1_776_000_000,
      tx: txids,
    });
    txByTxid.set("tx-good-1", makeCoinbaseTx("tx-good-1"));
    txByTxid.set(
      "tx-bad",
      new Error("RPC -5: No such mempool or blockchain transaction"),
    );
    txByTxid.set("tx-good-2", makeCoinbaseTx("tx-good-2"));

    await expect(fairRpc.getBlockWithTxs(99)).rejects.toThrow(
      /No such mempool/,
    );
  });

  it("getBlockAtHeight is a stable alias for getBlockWithTxs", async () => {
    const blockHash = "blockhash-alias";
    blockHashByHeight.set(1, blockHash);
    blockByHash.set(blockHash, {
      hash: blockHash,
      height: 1,
      confirmations: 1,
      time: 1_776_000_000,
      tx: ["tx-alias"],
    });
    txByTxid.set("tx-alias", makeCoinbaseTx("tx-alias"));

    const block = await fairRpc.getBlockAtHeight(1);
    expect(block.hash).toBe(blockHash);
    expect(block.tx[0]?.txid).toBe("tx-alias");
  });
});

describe("getRawTransaction (faircoin v3 numeric verbose)", () => {
  it("calls getrawtransaction with numeric verbose=1, never boolean", async () => {
    txByTxid.set(
      "lone-txid",
      makeRawTx("lone-txid", [
        {
          value: 5,
          n: 0,
          scriptPubKey: {
            address: "addr-lone",
            type: "pubkeyhash",
            asm: "asm",
            hex: "hex",
          },
        },
      ]),
    );

    const tx = await fairRpc.getRawTransaction("lone-txid");

    expect(tx.txid).toBe("lone-txid");
    const grtCall = calls.find((c) => c.method === "getrawtransaction");
    expect(grtCall).toBeDefined();
    if (!grtCall) throw new Error("getrawtransaction not called");
    expect(grtCall.params).toEqual(["lone-txid", 1]);
    expect(typeof grtCall.params[1]).toBe("number");
  });
});

afterAll(() => {
  // Clear the RPC handler so a later test file's `setRpcHandler` (or none
  // at all) takes effect cleanly. The shared dispatch class itself stays
  // installed — that's intentional, see test/mock-fair-rpc.ts.
  clearRpcHandler();
});
