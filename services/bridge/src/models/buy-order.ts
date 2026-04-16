import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Order lifecycle for the user-initiated "Buy FAIR" flow.
 *
 *   AWAITING_PAYMENT → user is yet to send payment to `paymentAddress`
 *   PAYMENT_DETECTED → at least one inbound payment seen (mempool or block)
 *   SWAPPING         → bridge has confirmed funds and is executing the
 *                      USDC↔WFAIR swap on Uniswap v3 (Base)
 *   BURNING          → swap settled, calling WFAIR.bridgeBurn() with the
 *                      user's FAIR address embedded
 *   DELIVERING       → BridgeBurn event picked up by base-watcher; release
 *                      enqueued and awaiting faircoind broadcast
 *   DELIVERED        → faircoind broadcast confirmed; FAIR has reached the
 *                      user's HD address. `releaseFairTxId` is populated.
 *   FAILED           → unrecoverable error (see `errorMessage`)
 *   EXPIRED          → quote window elapsed before payment was detected
 */
export const BUY_ORDER_STATUSES = [
  "AWAITING_PAYMENT",
  "PAYMENT_DETECTED",
  "SWAPPING",
  "BURNING",
  "DELIVERING",
  "DELIVERED",
  "FAILED",
  "EXPIRED",
] as const;
export type BuyOrderStatus = (typeof BUY_ORDER_STATUSES)[number];

export const PAYMENT_CURRENCIES = [
  "USDC_BASE",
  "ETH_BASE",
  "ETH_MAINNET",
  "BTC",
  "CARD",
] as const;
export type PaymentCurrency = (typeof PAYMENT_CURRENCIES)[number];

const buyOrderSchema = new Schema(
  {
    // User-requested FAIR amount in smallest units (m⊜ — 1 FAIR = 1e8).
    // Stored as string for the same reason wei amounts are: bigint precision.
    fairAmountSats: { type: String, required: true },

    // FAIR HD address chosen by the wallet that will receive the delivered
    // coins. Validated against faircoind on quote creation.
    fairDestinationAddress: { type: String, required: true },

    paymentCurrency: {
      type: String,
      enum: PAYMENT_CURRENCIES,
      required: true,
    },

    // For crypto payments: the address the bridge controls and the user must
    // send funds to. For CARD: null (URL is in `cardPaymentUrl`).
    paymentAddress: { type: String, default: null },

    // Smallest-unit amount the user must send. Encoding depends on currency:
    //   USDC_BASE:    6-decimal microUSDC  (1 USDC = 1e6)
    //   ETH_*:        18-decimal wei
    //   BTC:          satoshi (1e8)
    //   CARD:         decimal USD cents
    // Stored as string for bigint safety.
    paymentAmount: { type: String, required: true },

    // Hosted card-payment redirect URL (Moonpay/Transak). Mutually exclusive
    // with paymentAddress: only one is non-null per order.
    cardPaymentUrl: { type: String, default: null },

    // For payment addresses derived from a bridge-controlled HD: the derived
    // index. Used by the watcher to know which addresses are live.
    paymentHdIndex: { type: Number, default: null },

    paymentExpiresAt: { type: Date, required: true },

    status: {
      type: String,
      enum: BUY_ORDER_STATUSES,
      required: true,
      default: "AWAITING_PAYMENT",
    },

    // Set when the watcher first sees an inbound payment to paymentAddress.
    paymentDetectedTxHash: { type: String, default: null },

    // Set after the Uniswap swap completes successfully on Base.
    swapTxHash: { type: String, default: null },
    swapWfairOut: { type: String, default: null },

    // Set after the bridgeBurn() tx confirms.
    burnTxHash: { type: String, default: null },

    // Final faircoind txid that delivers FAIR to the user.
    releaseFairTxId: { type: String, default: null },

    // Fee/slippage accounting captured at quote time so we can audit spreads
    // without recomputing pool state.
    feeBreakdown: {
      uniswapBps: { type: Number, default: 0 },
      bridgeBps: { type: Number, default: 0 },
      slippageBufferBps: { type: Number, default: 0 },
    },

    // Optional client identifier for retention / abuse correlation. Never a PII
    // requirement; FAIRWallet sends an opaque per-install UUID.
    userIdentifier: { type: String, default: null },

    clientIp: { type: String, default: null },

    errorMessage: { type: String, default: null },
  },
  { timestamps: true, collection: "buy_orders" },
);

// Address re-use across orders is forbidden: each AWAITING_PAYMENT order has
// a unique payment address derived from the bridge's buy-side HD chain, so
// the watcher can attribute deposits unambiguously without window/age checks.
// Sparse so CARD orders (paymentAddress = null) don't collide on null.
buyOrderSchema.index(
  { paymentAddress: 1 },
  { unique: true, sparse: true },
);
buyOrderSchema.index({ status: 1, createdAt: -1 });
buyOrderSchema.index({ fairDestinationAddress: 1, createdAt: -1 });
buyOrderSchema.index({ paymentExpiresAt: 1 });

export type BuyOrderDoc = InferSchemaType<typeof buyOrderSchema> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export const BuyOrder: Model<BuyOrderDoc> =
  (mongoose.models.BuyOrder as Model<BuyOrderDoc> | undefined) ??
  mongoose.model<BuyOrderDoc>("BuyOrder", buyOrderSchema);
