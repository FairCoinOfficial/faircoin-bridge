import mongoose, {
  Schema,
  type InferSchemaType,
  type Model,
} from "mongoose";

/**
 * Lifecycle of one distribution attempt.
 *
 *   PENDING                      → cycle row created, payouts not yet built
 *   PAYING_OUT                   → payouts built; sendtoaddress fan-out in flight
 *   COMPLETE                     → every payout has a txid (BROADCAST or CONFIRMED)
 *   FAILED                       → at least one payout failed and is non-recoverable
 *   SKIPPED_NO_MASTERNODES       → no ENABLED masternodes on chain this tick
 *   SKIPPED_BELOW_THRESHOLD      → pool balance < MASTERNODE_REWARDS_MIN_BALANCE_FAIR
 *   SKIPPED_DISABLED             → MASTERNODE_REWARDS_ENABLED=false
 */
export const MASTERNODE_REWARD_CYCLE_STATUSES = [
  "PENDING",
  "PAYING_OUT",
  "COMPLETE",
  "FAILED",
  "SKIPPED_NO_MASTERNODES",
  "SKIPPED_BELOW_THRESHOLD",
  "SKIPPED_DISABLED",
] as const;
export type MasternodeRewardCycleStatus =
  (typeof MASTERNODE_REWARD_CYCLE_STATUSES)[number];

/**
 * Per-masternode payout record. `status` is independent of the cycle's status
 * — the cycle only flips to COMPLETE once every payout is BROADCAST/CONFIRMED.
 *
 * `masternodeOutpoint` is the canonical "txhash-outidx" identifier returned
 * by `masternodelist` and is what we use as an idempotency key inside the
 * cycle (no two payouts in the same cycle may target the same outpoint, so
 * a partial-replay can detect already-paid outpoints and skip them).
 */
export const MASTERNODE_PAYOUT_STATUSES = [
  "PENDING",
  "BROADCAST",
  "CONFIRMED",
  "FAILED",
] as const;
export type MasternodePayoutStatus =
  (typeof MASTERNODE_PAYOUT_STATUSES)[number];

const masternodePayoutSchema = new Schema(
  {
    masternodeOutpoint: { type: String, required: true },
    payoutAddress: { type: String, required: true },
    // sats, encoded as string for bigint safety (same convention as
    // Withdrawal.amountSats and Deposit.amountSats).
    amountSats: { type: String, required: true },
    status: {
      type: String,
      enum: MASTERNODE_PAYOUT_STATUSES,
      required: true,
      default: "PENDING",
    },
    txid: { type: String, default: null },
    errorMessage: { type: String, default: null },
  },
  // Subdocument: no separate _id, no own timestamps. Cycle's updatedAt is
  // the canonical "last touched" marker for the whole batch.
  { _id: false },
);

const masternodeRewardCycleSchema = new Schema(
  {
    triggeredAt: { type: Date, required: true, default: () => new Date() },
    // Total FAIR sitting in the reward pool address at trigger time, in sats
    // (string-encoded bigint). Includes the portion later subtracted as the
    // tx-fee budget — the per-masternode amount is computed AFTER the fee
    // reservation in `perMasternodeFair`.
    poolBalanceFair: { type: String, required: true },
    activeMasternodes: { type: Number, required: true, default: 0 },
    // Per-masternode payout amount in sats (string-encoded bigint). Equal to
    // floor((poolBalanceFair − N * MASTERNODE_REWARDS_PAYOUT_FEE_FAIR) / N).
    perMasternodeFair: { type: String, required: true, default: "0" },
    payouts: { type: [masternodePayoutSchema], default: [] },
    status: {
      type: String,
      enum: MASTERNODE_REWARD_CYCLE_STATUSES,
      required: true,
      default: "PENDING",
    },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true, collection: "masternode_reward_cycles" },
);

// Operator-facing: most recent cycle of a given status.
masternodeRewardCycleSchema.index({ status: 1, createdAt: -1 });
// Tick-loop dedupe / cadence audit: most recent triggers first.
masternodeRewardCycleSchema.index({ triggeredAt: -1 });

export type MasternodeRewardCycleDoc = InferSchemaType<
  typeof masternodeRewardCycleSchema
> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export type MasternodeRewardPayoutDoc = InferSchemaType<
  typeof masternodePayoutSchema
>;

export const MasternodeRewardCycle: Model<MasternodeRewardCycleDoc> =
  (mongoose.models.MasternodeRewardCycle as
    | Model<MasternodeRewardCycleDoc>
    | undefined) ??
  mongoose.model<MasternodeRewardCycleDoc>(
    "MasternodeRewardCycle",
    masternodeRewardCycleSchema,
  );
