import { HDKey } from "@scure/bip32";
import {
  getNetwork,
  publicKeyToAddress,
  type NetworkConfig,
} from "@fairco.in/core";
import { config } from "../config.js";
import { Deposit } from "../models/deposit.js";
import { HdState } from "../models/hd-state.js";

/**
 * FAIR deposit-address derivation (watch-only, xpub-based).
 *
 * The bridge never holds the deposit xprv: the user-controlled HD is
 * operator-managed off-host. We receive only FAIR_BRIDGE_XPUB at the configured
 * path prefix (`FAIR_DEPOSIT_DERIVATION_PATH`, default m/44'/119'/0'/0) and
 * derive external-chain children (`.../{index}`) to allocate deposit
 * addresses. Withdrawals sign with a separate hot wallet key.
 */

function getFairNetwork(): NetworkConfig {
  return getNetwork(config.FAIR_NETWORK);
}

function getXpubRoot(): HDKey {
  if (!config.FAIR_BRIDGE_XPUB) {
    throw new Error("FAIR_BRIDGE_XPUB is not configured");
  }
  const network = getFairNetwork();
  // Tell bip32 which version bytes this xpub uses so decoding succeeds even
  // when the network uses non-standard BIP32 versions (FairCoin does).
  return HDKey.fromExtendedKey(config.FAIR_BRIDGE_XPUB, {
    private: network.bip32.private,
    public: network.bip32.public,
  });
}

export async function deriveDepositAddress(index: number): Promise<string> {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`invalid derivation index: ${String(index)}`);
  }
  const root = getXpubRoot();
  const child = root.deriveChild(index);
  if (!child.publicKey) {
    throw new Error("HDKey child is missing publicKey (neutered?)");
  }
  return publicKeyToAddress(child.publicKey, getFairNetwork());
}

export async function getNextIndex(): Promise<number> {
  const updated = await HdState.findOneAndUpdate(
    { _id: "fair_deposit" },
    { $inc: { nextIndex: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean<{ _id: string; nextIndex: number } | null>();
  if (!updated) {
    throw new Error("failed to allocate HD index");
  }
  // $inc with upsert returns the post-increment value; pre-increment = nextIndex - 1
  return updated.nextIndex - 1;
}

export async function allocateNextDepositAddress(): Promise<{
  index: number;
  address: string;
}> {
  const index = await getNextIndex();
  const address = await deriveDepositAddress(index);
  addressCache.add(address);
  return { index, address };
}

const addressCache: Set<string> = new Set<string>();
let addressCacheLoaded = false;

export async function getKnownDepositAddressSet(): Promise<Set<string>> {
  if (addressCacheLoaded) return addressCache;
  const cursor = Deposit.find({}, { fairAddress: 1 })
    .lean<Array<{ fairAddress: string }>>()
    .cursor();
  for await (const row of cursor) {
    if (row.fairAddress) addressCache.add(row.fairAddress);
  }
  addressCacheLoaded = true;
  return addressCache;
}
