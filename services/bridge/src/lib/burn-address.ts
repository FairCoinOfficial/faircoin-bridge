import { encodeAddress, getNetwork } from "@fairco.in/core";
import type { NetworkType } from "@fairco.in/core";

/**
 * Provably-unspendable FairCoin burn address.
 *
 * Bitcoin's `1Counterparty…` style addresses are constructed by encoding a
 * known-but-unsignable hash160 with the network's pubkey-hash version byte.
 * Since hash160 is a one-way function (RIPEMD-160 ∘ SHA-256), no private key
 * can produce the all-zero hash; any UTXO sent to such an address is
 * permanently unspendable.
 *
 * For FairCoin mainnet (PUBKEY_ADDRESS version = 35, ASCII 'F'), the
 * canonical burn address is `base58check(0x23 || 0x00 * 20)`. On testnet
 * (version = 65, ASCII 'T') the analogue starts with 'T'. We build it from
 * the active network's pubKeyHash byte rather than hard-coding the string so
 * dev/test env's burn destination matches the FAIR network the bridge is
 * pointed at.
 *
 * The result is the same value the operator should set in
 * `FAIR_BURN_ADDRESS`; if that env var is provided, it takes precedence and
 * we honour it. If left blank, the worker substitutes this canonical default.
 */
export function deriveCanonicalBurnAddress(network: NetworkType): string {
  const cfg = getNetwork(network);
  const allZeroHash160 = new Uint8Array(20);
  return encodeAddress(allZeroHash160, cfg.pubKeyHash);
}
