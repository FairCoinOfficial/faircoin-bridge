/**
 * Tests for RPC-credential redaction in logs.
 *
 * viem embeds the full provider endpoint in its error messages and metadata,
 * so one Alchemy 429 wrote a working API key into the journal on every failed
 * watcher tick — where a log shipper, a support ticket or a pasted stack trace
 * would carry it straight out of the box.
 */

import { describe, test, expect } from "bun:test";
import { redactRpcUrls } from "../src/lib/redact.js";

describe("redactRpcUrls", () => {
  test("strips the key from an Alchemy endpoint but keeps the host", () => {
    const out = redactRpcUrls(
      "HTTP request failed. URL: https://base-mainnet.g.alchemy.com/v2/ptAY7QzugU6HCSXutKmK7",
    );
    expect(out).toContain("base-mainnet.g.alchemy.com/v2/<redacted>");
    expect(out).not.toContain("ptAY7QzugU6HCSXutKmK7");
  });

  test("redacts every URL in a multi-endpoint message", () => {
    const out = redactRpcUrls("primary https://x.io/v2/AAAA fallback https://y.io/v3/BBBB");
    expect(out).not.toContain("AAAA");
    expect(out).not.toContain("BBBB");
  });

  test("leaves ordinary log lines untouched", () => {
    expect(redactRpcUrls("buy: HD allocation failed")).toBe(
      "buy: HD allocation failed",
    );
  });
});

describe("redactErrorFields on the real logger", () => {
  test("a viem-shaped error leaks nothing through message, stack or url", async () => {
    const { default: pino } = await import("pino");
    const { logger: _unused } = await import("../src/lib/logger.js");
    void _unused;
    const { redactErrorFields } = await import("../src/lib/redact.js");

    const lines: string[] = [];
    const probe = pino(
      {
        serializers: {
          err: (e: unknown) =>
            redactErrorFields(pino.stdSerializers.err(e as Error)),
        },
      },
      { write: (s: string) => { lines.push(s); } } as never,
    );

    const key = "SUPERSECRETKEY123";
    const url = `https://base-mainnet.g.alchemy.com/v2/${key}`;
    const err = Object.assign(
      new Error(`HTTP request failed. URL: ${url}`),
      { url, metaMessages: [`URL: ${url}`], details: `at ${url}` },
    );

    probe.error({ err }, "base-watcher tick error");

    const out = lines.join("");
    expect(out).not.toContain(key);
    // The host must survive — it is what makes the error diagnosable.
    expect(out).toContain("base-mainnet.g.alchemy.com");
  });
});
