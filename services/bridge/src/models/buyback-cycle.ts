import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Lifecycle of a single buy-back + burn + distribution cycle driven by the
 * buyback worker. One row per cycle the worker triggers (whether on its
 * timer tick or via the admin trigger endpoint).
 *
 *   PENDING            → row created, threshold satisfied, nothing on chain yet
 *   SWAPPING           → USDC → WFAIR swap broadcast on Uniswap v3
 *   BURNING            → bridgeBurn(burn destination) broadcast
 *   TREASURY_SENDING   → bridgeBurn(treasury destination) broadcast
 *   MASTERNODE_SENDING → bridgeBurn(masternode pool destination) broadcast
 *   COMPLETE           → all four chain side-effects confirmed
 *   FAILED             → unrecoverable error (see errorMessage)
 *
 * Idempotency: each on-chain side-effect's tx hash is persisted BEFORE its
 * receipt is awaited (mirroring the pattern in src/signer/base.ts and
 * src/signer/fair.ts). On retry, if a hash is already on file, the worker
 * reconciles via `waitForTransactionReceipt` rather than re-broadcasting.
 */
export const BUYBACK_CYCLE_STATUSES = [
  "PENDING",
  "SWAPPING",
  "BURNING",
  "TREASURY_SENDING",
  "MASTERNODE_SENDING",
  "COMPLETE",
  "FAILED",
] as const;
export type BuybackCycleStatus = (typeof BUYBACK_CYCLE_STATUSES)[number];

const buybackCycleSchema = new Schema(
  {
    triggeredAt: { type: Date, required: true, default: Date.now },

    // Raw 6-decimal microUSDC amount the swap was sized against. Captured at
    // claim time so that USDC arriving mid-cycle does not retroactively
    // change the cycle's accounting.
    usdcAmount: { type: String, required: true },

    // Uniswap v3 exactInputSingle tx hash. Persisted BEFORE awaiting the
    // receipt so a crash here re-enters the reconciliation branch on retry.
    swapTxHash: { type: String, default: null },

    // Total WFAIR (raw 18-dec wei) credited to the bridge EOA after the
    // swap settled. Used as the denominator for the BPS split.
    wfairAcquiredWei: { type: String, default: null },

    // bridgeBurn() tx hashes for each destination, in order.
    burnTxHash: { type: String, default: null },
    treasuryTxHash: { type: String, default: null },
    masternodeTxHash: { type: String, default: null },

    // Computed amounts (raw 18-dec wei) the worker passed to each
    // bridgeBurn call. Sum equals wfairAcquiredWei within rounding (the
    // burn share absorbs any wei left over from integer division).
    burnAmountWei: { type: String, default: null },
    treasuryAmountWei: { type: String, default: null },
    masternodeAmountWei: { type: String, default: null },

    status: {
      type: String,
      enum: BUYBACK_CYCLE_STATUSES,
      required: true,
      default: "PENDING",
    },

    errorMessage: { type: String, default: null },
  },
  { timestamps: true, collection: "buyback_cycles" },
);

// (status, createdAt) — admin status endpoint queries last N rows by createdAt
// regardless of status; the compound index supports both filtered and
// unfiltered tails.
buybackCycleSchema.index({ status: 1, createdAt: -1 });
buybackCycleSchema.index({ triggeredAt: -1 });

export type BuybackCycleDoc = InferSchemaType<typeof buybackCycleSchema> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export const BuybackCycle: Model<BuybackCycleDoc> =
  (mongoose.models.BuybackCycle as Model<BuybackCycleDoc> | undefined) ??
  mongoose.model<BuybackCycleDoc>("BuybackCycle", buybackCycleSchema);
