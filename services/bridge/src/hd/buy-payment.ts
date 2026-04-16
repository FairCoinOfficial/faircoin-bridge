import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hdKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { config } from "../config.js";
import { HdState } from "../models/hd-state.js";

/**
 * Buy-side EVM payment address derivation.
 *
 * Each Buy order needs a fresh, bridge-controlled receiving address on Base
 * (USDC/ETH). The bridge MUST hold the corresponding private key so it can
 * sweep funds into the Uniswap router for the swap.
 *
 * Derivation: BIP44 Ethereum cointype 60 under a dedicated xprv root
 * (`BUY_PAYMENT_HD_XPRV` or `BUY_PAYMENT_HD_MNEMONIC`). Path is
 * `m/44'/60'/0'/0/{index}`. Index lives in the `base_buy_payment` row of
 * `hd_state` and is monotonically incremented per allocation, mirroring the
 * deposit-side `getNextIndex` pattern.
 *
 * This HD chain is separate from FAIR_BRIDGE_XPUB (FAIR deposit watch-only)
 * and from BRIDGE_EOA_PRIVATE_KEY (the gas/mint signer). Funds landing here
 * are short-lived: the orchestrator sweeps them as soon as the swap step runs.
 */

let cachedRoot: HDKey | null = null;

function getBuyPaymentRoot(): HDKey {
  if (cachedRoot) return cachedRoot;
  if (config.BUY_PAYMENT_HD_XPRV) {
    cachedRoot = HDKey.fromExtendedKey(config.BUY_PAYMENT_HD_XPRV);
    return cachedRoot;
  }
  if (config.BUY_PAYMENT_HD_MNEMONIC) {
    const seed = mnemonicToSeedSync(config.BUY_PAYMENT_HD_MNEMONIC);
    cachedRoot = HDKey.fromMasterSeed(seed);
    return cachedRoot;
  }
  throw new Error(
    "BUY_PAYMENT_HD_XPRV or BUY_PAYMENT_HD_MNEMONIC must be configured to allocate buy-side payment addresses",
  );
}

export interface DerivedBuyPaymentKey {
  index: number;
  privateKey: `0x${string}`;
  address: Address;
}

export function deriveBuyPaymentKey(index: number): DerivedBuyPaymentKey {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`invalid buy-payment derivation index: ${String(index)}`);
  }
  const root = getBuyPaymentRoot();
  // viem's hdKeyToAccount expects the HDKey root (m/) and walks the BIP44
  // Ethereum path itself: m/44'/60'/{accountIndex}'/{change}/{addressIndex}.
  // We use accountIndex=0, change=0, addressIndex=index.
  const account = hdKeyToAccount(root, {
    accountIndex: 0,
    changeIndex: 0,
    addressIndex: index,
  });
  if (!account.getHdKey().privateKey) {
    throw new Error("buy-payment HD child has no private key");
  }
  const privateKey = `0x${bytesToHex(account.getHdKey().privateKey as Uint8Array)}` as `0x${string}`;
  return {
    index,
    privateKey,
    address: account.address,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export async function allocateNextBuyPaymentAddress(): Promise<DerivedBuyPaymentKey> {
  const updated = await HdState.findOneAndUpdate(
    { _id: "base_buy_payment" },
    { $inc: { nextIndex: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean<{ _id: string; nextIndex: number } | null>();
  if (!updated) {
    throw new Error("failed to allocate buy-payment HD index");
  }
  // $inc with upsert returns the post-increment value; pre-increment = nextIndex - 1
  const index = updated.nextIndex - 1;
  return deriveBuyPaymentKey(index);
}
