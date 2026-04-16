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

const BlockVerboseSchema = z.object({
  hash: z.string(),
  height: z.number(),
  confirmations: z.number(),
  time: z.number(),
  previousblockhash: z.string().optional(),
  tx: z.array(BlockTxSchema),
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

export async function getTipHeight(): Promise<number> {
  return fairRpc.call<number>("getblockcount");
}

export async function getBlockAtHeight(
  height: number,
): Promise<BlockVerbose> {
  const hash = await fairRpc.call<string>("getblockhash", [height]);
  const raw = await fairRpc.call<unknown>("getblock", [hash, 2]);
  return BlockVerboseSchema.parse(raw);
}

export async function getRawTransaction(
  txid: string,
): Promise<RawTransaction> {
  const raw = await fairRpc.call<unknown>("getrawtransaction", [txid, true]);
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
