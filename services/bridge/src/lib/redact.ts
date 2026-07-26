/**
 * Scrubbing of credentials that leak into free-text log messages.
 *
 * Kept apart from `logger.ts` deliberately: that module builds the pino
 * instance and is `mock.module`-ed by worker tests, which would take these
 * helpers down with it. This one is pure, has no dependencies, and can be
 * tested and reused on its own.
 */

/**
 * Replace the credential segment of any provider RPC URL in `text`.
 *
 * viem embeds the full endpoint in its error messages and metadata, so a
 * single provider 429 wrote a working API key into the journal on every failed
 * watcher tick. The host is kept — it is what makes the error diagnosable —
 * and only the key is censored.
 */
export function redactRpcUrls(text: string): string {
  // Alchemy / Infura shape: https://host/v2/<key>
  return text.replace(
    /(https?:\/\/[^\s/]+\/v[0-9]+\/)[A-Za-z0-9_-]+/g,
    "$1<redacted>",
  );
}
