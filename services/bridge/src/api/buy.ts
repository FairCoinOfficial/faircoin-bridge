import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import mongoose from "mongoose";
import { z } from "zod";
import { config } from "../config.js";
import { allocateNextBuyPaymentAddress } from "../hd/buy-payment.js";
import { logger } from "../lib/logger.js";
import {
  BuyOrder,
  type BuyOrderDoc,
  PAYMENT_CURRENCIES,
  type PaymentCurrency,
} from "../models/buy-order.js";
import {
  quoteUsdcInForExactWfairOut,
  quoteWfairOutForExactUsdcIn,
} from "../rpc/uniswap.js";
import { validateAddress as fairValidateAddress } from "../rpc/fair.js";
import { validate } from "./validate.js";

const SATS_PER_FAIR = 100_000_000n;
const SATS_TO_WEI = 10_000_000_000n; // 1e10
const BPS_DENOM = 10_000n;
const USDC_DECIMALS = 6n;
const ETH_DECIMALS = 18n;
const MAX_AWAITING_PER_IP = 20;

// CARD payment is gated behind a configured Moonpay/Transak key. Until the
// business KYC is complete, the API exposes the option but refuses to mint a
// quote — the FAIRWallet UI surfaces this as "Coming soon".
function isCardSupported(): boolean {
  return Boolean(config.MOONPAY_API_KEY ?? config.TRANSAK_API_KEY);
}

const QuoteBody = z
  .object({
    /**
     * FAIR amount the user wants to receive. Accepts decimal string ("100"
     * or "12.5") or whole number. Bounded by BUY_MIN_FAIR / BUY_MAX_FAIR.
     */
    fairAmount: z
      .union([z.string(), z.number()])
      .transform((v) => (typeof v === "number" ? v.toString() : v))
      .refine((v) => /^\d+(\.\d{1,8})?$/.test(v), "fairAmount must be a decimal with ≤ 8 places"),
    paymentCurrency: z.enum(PAYMENT_CURRENCIES),
    fairDestinationAddress: z
      .string()
      .min(20)
      .max(64)
      .refine((v) => /^[FTM][a-km-zA-HJ-NP-Z1-9]+$/.test(v), "invalid faircoin address"),
    userIdentifier: z.string().min(1).max(128).optional(),
  })
  .strict();

const StatusParams = z
  .object({
    id: z
      .string()
      .refine((v) => mongoose.isValidObjectId(v), "invalid buy order id"),
  })
  .strict();

const intentLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limited", reason: "too_many_quote_requests" },
});

export const buyRouter: Router = Router();

function fairAmountToSats(fairAmount: string): bigint {
  const parts = fairAmount.split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  const wholeSats = BigInt(whole) * SATS_PER_FAIR;
  const padded = (frac + "00000000").slice(0, 8);
  const fracSats = BigInt(padded);
  return wholeSats + fracSats;
}

function fairSatsToWfairWei(sats: bigint): bigint {
  // WFAIR has 18 decimals; FAIR has 8. 1 FAIR = 1e8 sats = 1e18 wei.
  return sats * SATS_TO_WEI;
}

function applyFee(amount: bigint, feeBps: bigint): bigint {
  // Caller pays ⇒ we INCREASE the amount they must send by the fee.
  return (amount * (BPS_DENOM + feeBps)) / BPS_DENOM;
}

function applyBuffer(amount: bigint, bufferBps: bigint): bigint {
  return (amount * (BPS_DENOM + bufferBps)) / BPS_DENOM;
}

interface PaymentQuote {
  paymentAmount: bigint;
  paymentDecimals: number;
  /** Human-readable currency symbol used by the wallet UI. */
  symbol: string;
  /** Network label used by the wallet's "send to this network" warning. */
  networkLabel: string;
}

async function quoteUsdcPayment(wfairWei: bigint): Promise<PaymentQuote> {
  // Quoter call — we need this many microUSDC to receive `wfairWei` WFAIR.
  const usdcRaw = await quoteUsdcInForExactWfairOut(wfairWei);
  // Apply slippage buffer + bridge fee on top of the raw quote.
  const slippage = BigInt(config.BUY_SLIPPAGE_BUFFER_BPS);
  const fee = BigInt(config.BUY_BRIDGE_FEE_BPS);
  const usdcWithBuffer = applyBuffer(usdcRaw, slippage);
  const usdcWithFee = applyFee(usdcWithBuffer, fee);
  return {
    paymentAmount: usdcWithFee,
    paymentDecimals: Number(USDC_DECIMALS),
    symbol: "USDC",
    networkLabel: "Base",
  };
}

function quoteEthBasePayment(_wfairWei: bigint): Promise<PaymentQuote> {
  // ETH-on-Base requires a separate ETH/USDC pool quoter step inside the
  // orchestrator (ETH → USDC → WFAIR). That hop adds slippage and a second
  // gas tx; we ship USDC-only in v1 and surface ETH_BASE as "unavailable"
  // until the ETH/USDC route is wired and tested.
  return Promise.reject(
    new BuyQuoteError(
      "ETH_BASE payments are temporarily disabled — use USDC_BASE",
      503,
      "currency_unavailable",
    ),
  );
}

class BuyQuoteError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function buildPaymentQuote(
  paymentCurrency: PaymentCurrency,
  wfairWei: bigint,
): Promise<PaymentQuote> {
  switch (paymentCurrency) {
    case "USDC_BASE":
      return quoteUsdcPayment(wfairWei);
    case "ETH_BASE":
      return quoteEthBasePayment(wfairWei);
    case "ETH_MAINNET":
      throw new BuyQuoteError(
        "ETH_MAINNET payments are not yet supported",
        503,
        "currency_unavailable",
      );
    case "BTC":
      throw new BuyQuoteError(
        "BTC payments are not yet supported",
        503,
        "currency_unavailable",
      );
    case "CARD":
      throw new BuyQuoteError(
        "Card payments are coming soon",
        503,
        "card_not_configured",
      );
  }
}

buyRouter.post(
  "/quote",
  intentLimiter,
  validate(QuoteBody, "body"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = req.parsed as z.infer<typeof QuoteBody>;
    const clientIp = req.ip ?? null;

    if (clientIp) {
      const outstanding = await BuyOrder.countDocuments({
        clientIp,
        status: "AWAITING_PAYMENT",
      });
      if (outstanding >= MAX_AWAITING_PER_IP) {
        res.status(429).json({
          error: "rate_limited",
          reason: "too_many_outstanding_quotes",
        });
        return;
      }
    }

    const fairSats = fairAmountToSats(parsed.fairAmount);
    const minSats = BigInt(Math.round(config.BUY_MIN_FAIR * Number(SATS_PER_FAIR)));
    const maxSats = BigInt(Math.round(config.BUY_MAX_FAIR * Number(SATS_PER_FAIR)));

    if (fairSats < minSats) {
      res.status(400).json({
        error: "invalid_request",
        code: "below_minimum",
        minimumFair: config.BUY_MIN_FAIR.toString(),
      });
      return;
    }
    if (fairSats > maxSats) {
      res.status(400).json({
        error: "invalid_request",
        code: "above_maximum",
        maximumFair: config.BUY_MAX_FAIR.toString(),
      });
      return;
    }

    // Validate FAIR destination against the configured node so we don't
    // accept payments for an address faircoind would refuse to send to later.
    const validation = await fairValidateAddress(parsed.fairDestinationAddress).catch(() => null);
    if (!validation || !validation.isvalid) {
      res.status(400).json({
        error: "invalid_request",
        code: "invalid_fair_destination",
      });
      return;
    }

    const wfairWei = fairSatsToWfairWei(fairSats);

    let quote: PaymentQuote;
    try {
      quote = await buildPaymentQuote(parsed.paymentCurrency, wfairWei);
    } catch (err: unknown) {
      if (err instanceof BuyQuoteError) {
        res.status(err.status).json({ error: err.code, message: err.message });
        return;
      }
      logger.error({ err }, "buy: quoter call failed");
      res.status(502).json({
        error: "pool_quote_failed",
        message: "Pool quote unavailable; try again shortly.",
      });
      return;
    }

    let paymentAddress: string | null = null;
    let paymentHdIndex: number | null = null;
    let cardPaymentUrl: string | null = null;

    if (parsed.paymentCurrency === "CARD") {
      if (!isCardSupported()) {
        res.status(503).json({
          error: "card_not_configured",
          message: "Card payments are coming soon",
        });
        return;
      }
      // TODO when business KYC complete: build Moonpay/Transak signed URL.
      res.status(503).json({
        error: "card_not_configured",
        message: "Card provider integration pending",
      });
      return;
    } else {
      try {
        const allocated = await allocateNextBuyPaymentAddress();
        paymentAddress = allocated.address;
        paymentHdIndex = allocated.index;
      } catch (err: unknown) {
        logger.error({ err }, "buy: HD allocation failed");
        res.status(503).json({
          error: "address_allocation_failed",
          message: "Bridge HD not configured for buy flow",
        });
        return;
      }
    }

    const expiresAt = new Date(
      Date.now() + config.BUY_QUOTE_TTL_SECONDS * 1000,
    );

    const created = await BuyOrder.create({
      fairAmountSats: fairSats.toString(),
      fairDestinationAddress: parsed.fairDestinationAddress,
      paymentCurrency: parsed.paymentCurrency,
      paymentAddress,
      paymentAmount: quote.paymentAmount.toString(),
      cardPaymentUrl,
      paymentHdIndex,
      paymentExpiresAt: expiresAt,
      status: "AWAITING_PAYMENT",
      feeBreakdown: {
        uniswapBps: 0,
        bridgeBps: config.BUY_BRIDGE_FEE_BPS,
        slippageBufferBps: config.BUY_SLIPPAGE_BUFFER_BPS,
      },
      userIdentifier: parsed.userIdentifier ?? null,
      clientIp,
    });

    res.status(201).json(serializeQuote(created, quote));
  },
);

buyRouter.get(
  "/status/:id",
  validate(StatusParams, "params"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = req.parsed as z.infer<typeof StatusParams>;
    const doc = await BuyOrder.findById(parsed.id).lean<BuyOrderDoc | null>();
    if (!doc) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(serializeStatus(doc));
  },
);

function formatPaymentAmount(raw: string, decimals: number): string {
  // Render bigint string as a decimal with `decimals` fractional digits and
  // no trailing zeros. Used for the user-facing "send exactly X" string.
  const value = BigInt(raw);
  if (decimals <= 0) return value.toString();
  const denom = 10n ** BigInt(decimals);
  const whole = value / denom;
  const frac = value % denom;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

function nullable(value: string | null | undefined): string | null {
  return value ?? null;
}

function serializeQuote(doc: BuyOrderDoc, quote: PaymentQuote): {
  id: string;
  fairAmountSats: string;
  fairDestinationAddress: string;
  paymentCurrency: PaymentCurrency;
  paymentAddress: string | null;
  paymentAmount: string;
  paymentAmountFormatted: string;
  paymentDecimals: number;
  paymentSymbol: string;
  paymentNetworkLabel: string;
  cardPaymentUrl: string | null;
  paymentExpiresAt: string;
  estimatedDeliveryTime: string;
  feeBreakdown: {
    uniswapBps: number;
    bridgeBps: number;
    slippageBufferBps: number;
  };
} {
  return {
    id: doc._id.toString(),
    fairAmountSats: doc.fairAmountSats ?? "0",
    fairDestinationAddress: doc.fairDestinationAddress ?? "",
    paymentCurrency: doc.paymentCurrency as PaymentCurrency,
    paymentAddress: nullable(doc.paymentAddress),
    paymentAmount: doc.paymentAmount ?? "0",
    paymentAmountFormatted: formatPaymentAmount(
      doc.paymentAmount ?? "0",
      quote.paymentDecimals,
    ),
    paymentDecimals: quote.paymentDecimals,
    paymentSymbol: quote.symbol,
    paymentNetworkLabel: quote.networkLabel,
    cardPaymentUrl: nullable(doc.cardPaymentUrl),
    paymentExpiresAt: doc.paymentExpiresAt.toISOString(),
    estimatedDeliveryTime: "60-180 seconds after payment confirms",
    feeBreakdown: {
      uniswapBps: doc.feeBreakdown?.uniswapBps ?? 0,
      bridgeBps: doc.feeBreakdown?.bridgeBps ?? 0,
      slippageBufferBps: doc.feeBreakdown?.slippageBufferBps ?? 0,
    },
  };
}

function serializeStatus(doc: BuyOrderDoc): {
  id: string;
  status: string;
  fairAmountSats: string;
  fairDestinationAddress: string;
  paymentCurrency: PaymentCurrency;
  paymentAddress: string | null;
  paymentAmount: string;
  paymentExpiresAt: string;
  paymentDetectedTxHash: string | null;
  swapTxHash: string | null;
  burnTxHash: string | null;
  fairDeliveryTxId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: doc._id.toString(),
    status: doc.status ?? "AWAITING_PAYMENT",
    fairAmountSats: doc.fairAmountSats ?? "0",
    fairDestinationAddress: doc.fairDestinationAddress ?? "",
    paymentCurrency: doc.paymentCurrency as PaymentCurrency,
    paymentAddress: nullable(doc.paymentAddress),
    paymentAmount: doc.paymentAmount ?? "0",
    paymentExpiresAt: doc.paymentExpiresAt.toISOString(),
    paymentDetectedTxHash: nullable(doc.paymentDetectedTxHash),
    swapTxHash: nullable(doc.swapTxHash),
    burnTxHash: nullable(doc.burnTxHash),
    fairDeliveryTxId: nullable(doc.releaseFairTxId),
    errorMessage: nullable(doc.errorMessage),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// Re-export the formatter so the orchestrator and tests can use the same code
// path as the API serializer.
export { formatPaymentAmount };
