import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { config } from "../config.js";

const chain = config.BASE_NETWORK === "mainnet" ? base : baseSepolia;

const transport = config.BASE_RPC_URL_FALLBACK
  ? fallback([http(config.BASE_RPC_URL), http(config.BASE_RPC_URL_FALLBACK)])
  : http(config.BASE_RPC_URL);

export const basePublic = createPublicClient({
  chain,
  transport,
});

export const baseWallet = config.BRIDGE_EOA_PRIVATE_KEY
  ? createWalletClient({
      chain,
      transport,
      account: privateKeyToAccount(
        config.BRIDGE_EOA_PRIVATE_KEY as `0x${string}`,
      ),
    })
  : null;

export type BasePublicClient = typeof basePublic;
export type BaseWalletClient = NonNullable<typeof baseWallet>;

export function requireWallet(): BaseWalletClient {
  if (!baseWallet) {
    throw new Error(
      "BRIDGE_EOA_PRIVATE_KEY not configured — cannot sign Base txs",
    );
  }
  return baseWallet;
}

export { chain as baseChain };
