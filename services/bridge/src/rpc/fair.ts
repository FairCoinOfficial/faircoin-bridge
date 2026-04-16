import { FaircoinRpcClient } from "@fairco.in/rpc-client";
import { z } from "zod";
import { config } from "../config.js";

/**
 * faircoind RPC wrapper. The config always supplies FAIR_RPC_URL; user/pass
 * may be empty on a node configured to accept unauthenticated localhost RPC,
 * in which case we pass empty strings (Basic auth header still set but ignored
 * by the daemon).
 *
 * Bitcoin-Core-compatible RPC shapes are stable but not exported by the lib;
 * we validate with zod at the boundary and expose strongly-typed results.
 *
 * faircoind v3 quirk: forked from a pre-Bitcoin-0.15 codebase, so:
 *   - `getblock` accepts only a BOOLEAN verbose flag (true → JSON with txid
 *     array, false → hex). It rejects the modern integer verbosity-2 form
 *     ("value is type int, expected bool") and never returns decoded tx
 *     objects in the block payload.
 *   - `getrawtransaction` accepts only a NUMERIC verbose flag (0 → hex,
 *     non-zero → JSON object). It rejects the boolean form
 *     ("value is type bool, expected int").
 * To recover the modern verbosity-2 shape (block + decoded tx vouts) we
 * fetch the block with `getblock(hash, true)` then `getrawtransaction(txid,
 * 1)` for each txid and merge.
 */

export const fairRpc: FaircoinRpcClient = new FaircoinRpcClient({
  url: config.FAIR_RPC_URL,
  rpcUser: config.FAIR_RPC_USER ?? "",
  rpcPass: config.FAIR_RPC_PASSWORD ?? "",
});

const TxVoutSchema = z.object({
  value: z.number(),
  n: z.number(),
  scriptPubKey: z.object({
    addresses: z.array(z.string()).optional(),
    address: z.string().optional(),
    type: z.string(),
    asm: z.string(),
    hex: z.string(),
  }),
});

const BlockTxSchema = z.object({
  txid: z.string(),
  hash: z.string().optional(),
  vout: z.array(TxVoutSchema),
});

/**
 * Public block shape consumed by fair-watcher. `tx` is the array of *decoded*
 * transactions — we materialise this in `getBlockAtHeight` by fanning out to
 * `getrawtransaction` for each txid the daemon returns.
 */
const BlockVerboseSchema = z.object({
  hash: z.string(),
  height: z.number(),
  confirmations: z.number(),
  time: z.number(),
  previousblockhash: z.string().optional(),
  tx: z.array(BlockTxSchema),
});

/**
 * Wire-level shape of `getblock(hash, true)` on faircoin v3: identical to
 * `BlockVerboseSchema` except `tx` is a flat array of txid strings (no
 * decoded vouts). We never return this shape to callers — it is merged with
 * the per-tx fetches into `BlockVerboseSchema` before leaving this module.
 */
const RawBlockSchema = z.object({
  hash: z.string(),
  height: z.number(),
  confirmations: z.number(),
  time: z.number(),
  previousblockhash: z.string().optional(),
  tx: z.array(z.string()),
});

export type TxVout = z.infer<typeof TxVoutSchema>;
export type BlockTx = z.infer<typeof BlockTxSchema>;
export type BlockVerbose = z.infer<typeof BlockVerboseSchema>;

const RawTransactionSchema = z
  .object({
    txid: z.string(),
    hash: z.string().optional(),
    confirmations: z.number().optional(),
    blockhash: z.string().optional(),
    blocktime: z.number().optional(),
    vout: z.array(TxVoutSchema).optional(),
  })
  .passthrough();

export type RawTransaction = z.infer<typeof RawTransactionSchema>;

const ValidateAddressSchema = z.object({
  isvalid: z.boolean(),
  address: z.string().optional(),
});

export type ValidateAddressResult = z.infer<typeof ValidateAddressSchema>;

/**
 * Concurrency cap for the per-tx fetch fan-out inside `getBlockAtHeight`.
 * faircoin v3 nodes are single-threaded on the JSON-RPC side; a small ceiling
 * keeps us off the daemon's queue without sacrificing throughput on the
 * 1-5-tx blocks the chain currently produces.
 */
const PER_TX_FETCH_CONCURRENCY = 5;

/**
 * Run `task` over each item in `items` with at most `limit` in-flight at a
 * time, preserving input order in the result array. Any rejection cancels the
 * pool by short-circuiting via Promise.all-style propagation.
 */
async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  limit: number,
  task: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const results: TOut[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async (): Promise<void> => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= items.length) return;
          const item = items[index];
          if (item === undefined) return;
          results[index] = await task(item, index);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

export async function getTipHeight(): Promise<number> {
  return fairRpc.call<number>("getblockcount");
}

/**
 * Fetch the block at `height` with all transactions decoded. The decoded-tx
 * shape is materialised inside this module by fanning out to
 * `getrawtransaction` for each txid (see module-level note on faircoin v3
 * verbosity quirks). Public return shape is stable; callers never see the
 * raw txid-array form.
 */
export async function getBlockAtHeight(
  height: number,
): Promise<BlockVerbose> {
  return getBlockWithTxs(height);
}

/**
 * Same semantics as `getBlockAtHeight` — exported under the explicit name so
 * call sites that want to be unambiguous about the per-tx fetch cost can opt
 * in. Both names resolve to the same implementation.
 */
export async function getBlockWithTxs(
  height: number,
): Promise<BlockVerbose> {
  const hash = await fairRpc.call<string>("getblockhash", [height]);
  // boolean verbose: faircoin v3 only accepts true/false here.
  const rawBlockUnknown = await fairRpc.call<unknown>("getblock", [hash, true]);
  const rawBlock = RawBlockSchema.parse(rawBlockUnknown);
  const decodedTxs = await mapWithConcurrency(
    rawBlock.tx,
    PER_TX_FETCH_CONCURRENCY,
    async (txid) => {
      const raw = await getRawTransaction(txid);
      return BlockTxSchema.parse({
        txid: raw.txid,
        hash: raw.hash,
        vout: raw.vout ?? [],
      });
    },
  );
  return {
    hash: rawBlock.hash,
    height: rawBlock.height,
    confirmations: rawBlock.confirmations,
    time: rawBlock.time,
    previousblockhash: rawBlock.previousblockhash,
    tx: decodedTxs,
  };
}

export async function getRawTransaction(
  txid: string,
): Promise<RawTransaction> {
  // numeric verbose: faircoin v3 only accepts 0/1 here, NOT a bool.
  const raw = await fairRpc.call<unknown>("getrawtransaction", [txid, 1]);
  return RawTransactionSchema.parse(raw);
}

export async function sendRawTransaction(hex: string): Promise<string> {
  return fairRpc.call<string>("sendrawtransaction", [hex]);
}

export async function validateAddress(
  address: string,
): Promise<ValidateAddressResult> {
  const raw = await fairRpc.call<unknown>("validateaddress", [address]);
  return ValidateAddressSchema.parse(raw);
}

export async function sendToAddress(
  address: string,
  amountFair: number,
): Promise<string> {
  return fairRpc.call<string>("sendtoaddress", [address, amountFair]);
}

export async function getWalletBalanceSats(): Promise<bigint> {
  const balance = await fairRpc.call<number>("getbalance");
  return BigInt(Math.round(balance * 100_000_000));
}

/**
 * Total FAIR received at `address` (whole FAIR, 8-decimal float as returned
 * by the daemon). Used by the masternode reward worker to size the pool
 * without relying on whole-wallet balance — the bridge wallet also holds
 * deposit/hot-wallet UTXOs that must NOT be redistributed to masternodes.
 *
 * `minconf` defaults to 1 — funds must be at least one block deep so we
 * don't try to spend an unconfirmed pool credit on the very next tick.
 */
export async function getReceivedByAddressSats(
  address: string,
  minconf = 1,
): Promise<bigint> {
  const fair = await fairRpc.call<number>("getreceivedbyaddress", [
    address,
    minconf,
  ]);
  // Multiply via integer math to avoid float drift: 0.1 * 1e8 === 10000000.0000000002.
  // round() is safe because faircoind itself returns exactly 8 decimals.
  return BigInt(Math.round(fair * 100_000_000));
}

/**
 * Wire shape of a single entry returned by `masternodelist`. faircoind v3
 * returns a top-level JSON ARRAY (not the object-map keyed by `txhash-outidx`
 * found in modern Bitcoin-fork forks). Each entry has at minimum the
 * collateral outpoint (`txhash`/`outidx`), the lifecycle `status` (we treat
 * "ENABLED" as eligible for payouts) and the masternode's own FAIR address
 * `addr` — that is the address we send the pro-rata reward to.
 */
const MasternodeListEntrySchema = z
  .object({
    rank: z.number().optional(),
    txhash: z.string(),
    outidx: z.number(),
    status: z.string(),
    addr: z.string(),
    version: z.number().optional(),
    lastseen: z.number().optional(),
    activetime: z.number().optional(),
    lastpaid: z.number().optional(),
  })
  .passthrough();

const MasternodeListSchema = z.array(MasternodeListEntrySchema);

export type MasternodeListEntry = z.infer<typeof MasternodeListEntrySchema>;

/**
 * Fetch the current masternode list from faircoind. The optional `filter`
 * argument is a partial-match string the daemon applies against `txhash`,
 * `status`, or `addr`; we leave it unset so callers receive the full set
 * and can filter in TS (cleaner unit-tests, no daemon-version coupling).
 */
export async function getMasternodeList(): Promise<MasternodeListEntry[]> {
  const raw = await fairRpc.call<unknown>("masternodelist", []);
  return MasternodeListSchema.parse(raw);
}
