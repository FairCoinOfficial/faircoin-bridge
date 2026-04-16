// Unit tests for the pure helper functions exported from src/api/buy.ts.
// We don't spin up the express app here — the goal is to lock in the
// fair-amount-to-sats math and the bigint decimal formatter that the wallet
// renders without rounding errors.

import "./setup-env.js";

import { describe, expect, it } from "bun:test";

const { formatPaymentAmount } = await import("../src/api/buy.js");

describe("formatPaymentAmount", () => {
  it("renders microUSDC as a 6-decimal string with trailing zeros stripped", () => {
    expect(formatPaymentAmount("53500000", 6)).toBe("53.5");
  });

  it("renders integer USDC values without a decimal point", () => {
    expect(formatPaymentAmount("100000000", 6)).toBe("100");
  });

  it("preserves precision below the smallest visible unit", () => {
    expect(formatPaymentAmount("1", 6)).toBe("0.000001");
  });

  it("renders zero as '0' regardless of decimals", () => {
    expect(formatPaymentAmount("0", 18)).toBe("0");
  });

  it("falls back to the raw value if decimals is zero", () => {
    expect(formatPaymentAmount("12345", 0)).toBe("12345");
  });

  it("handles 18-decimal wei values correctly", () => {
    // 1.5 ETH in wei
    expect(formatPaymentAmount("1500000000000000000", 18)).toBe("1.5");
  });
});
