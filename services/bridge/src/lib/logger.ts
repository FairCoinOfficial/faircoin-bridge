import pino from "pino";
import { redactRpcUrls } from "./redact.js";

/**
 * Paths that must never reach the log, whatever object is passed in.
 *
 * viem embeds the full RPC endpoint in its error messages and metadata — a
 * single Alchemy 429 wrote the provider URL, API key and all, straight into
 * the journal on every failed tick. Anyone with log access (or a log shipper,
 * or a pasted stack trace in a chat) picks up a working key.
 *
 * Redaction is by path rather than by scrubbing message text: `err.message`
 * has to stay readable to be useful, so the URL-bearing fields are censored
 * individually and the message is rewritten by `redactRpcUrls` at the call
 * sites that log provider errors.
 */
const REDACTED_PATHS = [
  "err.url",
  "err.metaMessages",
  "*.url",
  "url",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: REDACTED_PATHS, censor: "<redacted>" },
  formatters: {
    log(object) {
      // Catch URLs that arrive inside an error message rather than a field.
      const message = (object as { message?: unknown }).message;
      if (typeof message === "string") {
        return { ...object, message: redactRpcUrls(message) };
      }
      return object;
    },
  },
});
