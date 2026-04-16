/**
 * Encode a FairCoin address as the raw UTF-8 bytes the WFAIR contract's
 * `bridgeBurn(amount, bytes faircoinAddress)` event expects.
 *
 * The complementary `decodeFaircoinAddressBytes` lives in
 * src/workers/base-watcher.ts and reverses this transformation when the
 * bridge picks up a BridgeBurn event off Base. The two MUST stay in sync:
 * any change here requires a paired change in the watcher decode.
 */
export function fairAddressToBytes(address: string): `0x${string}` {
  const bytes = new TextEncoder().encode(address);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `0x${hex}` as `0x${string}`;
}
