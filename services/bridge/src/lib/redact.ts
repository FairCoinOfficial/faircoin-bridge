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

/**
 * Scrub every field of a serialised error that can carry an endpoint.
 *
 * viem spreads the URL across `message`, `shortMessage`, `details`, `stack`
 * and `metaMessages`, so censoring the `url` property alone leaves a working
 * key in the log line. Applied as a pino `err` serializer, which is the only
 * seam that sees the whole error — a `formatters.log` hook does not, because
 * `logger.error({ err }, "msg")` puts nothing at the record's top level.
 */
export function redactErrorFields(value: unknown): unknown {
  if (typeof value === "string") return redactRpcUrls(value);
  if (Array.isArray(value)) return value.map(redactErrorFields);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactErrorFields(inner);
    }
    return out;
  }
  return value;
}
