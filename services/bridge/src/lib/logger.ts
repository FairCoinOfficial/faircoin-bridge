import pino from "pino";
import { redactErrorFields, redactRpcUrls } from "./redact.js";

/**
 * Logger for the bridge, with provider credentials scrubbed.
 *
 * viem embeds the full RPC endpoint — API key included — in its error
 * `message`, `stack`, `details` and `metaMessages`, and the watchers log the
 * error object wholesale. A single provider 429 therefore wrote a working key
 * into the journal on every tick.
 *
 * The scrubbing hangs off `serializers.err` rather than `redact` paths or a
 * `formatters.log` hook. Both of those were tried and neither works here:
 * `redact` only censors named paths, so `err.message` and `err.stack` sail
 * through, and `formatters.log` never sees the error at all because
 * `logger.error({ err }, "msg")` leaves the record's top level empty. The
 * serializer is the one seam handed the whole error object.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    err: (err: unknown) => redactErrorFields(pino.stdSerializers.err(err as Error)),
  },
  formatters: {
    // Covers the rarer `logger.error("… https://host/v2/key …")` shape, where
    // the endpoint is in the message rather than in an error object.
    log(object) {
      const message = (object as { message?: unknown }).message;
      return typeof message === "string"
        ? { ...object, message: redactRpcUrls(message) }
        : object;
    },
  },
});
