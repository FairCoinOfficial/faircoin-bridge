import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const DEPOSIT_STATUSES = [
  "AWAITING",
  "DETECTED",
  "CONFIRMED",
  "MINTING",
  "MINTED",
  "FAILED",
] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

// amountSats and amountWei stored as strings: Mongo Long maxes at 2^63, and
// bigint I/O through mongoose is awkward. String is simplest + safest for
// 18-decimal Wei values that easily exceed 2^63.
const depositSchema = new Schema(
  {
    baseAddress: { type: String, required: true },
    // Not unique: users naturally re-send to the same deposit address after
    // a prior mint settles. Each (fairTxid, fairVout) is its own deposit and
    // gets its own document. Uniqueness lives on the (fairTxid, fairVout)
    // compound index below.
    fairAddress: { type: String, required: true },
    hdIndex: { type: Number, required: true },
    status: {
      type: String,
      enum: DEPOSIT_STATUSES,
      required: true,
      default: "AWAITING",
    },
    fairTxid: { type: String, default: null },
    fairVout: { type: Number, default: null },
    fairBlockHeight: { type: Number, default: null },
    fairConfirmations: { type: Number, required: true, default: 0 },
    amountSats: { type: String, required: true, default: "0" },
    amountWei: { type: String, required: true, default: "0" },
    baseMintTxHash: { type: String, default: null },
    baseMintBlockNumber: { type: Number, default: null },
    // Safe-mode only: persisted immediately after proposal creation so retries
    // can reconcile against the Safe API instead of re-proposing.
    safeTxHash: { type: String, default: null },
    // Client IP of the /intent caller. Stored to enforce a per-IP outstanding
    // AWAITING cap and throttle HD index exhaustion attempts.
    clientIp: { type: String, default: null },
  },
  { timestamps: true, collection: "deposits" },
);

depositSchema.index(
  { fairTxid: 1, fairVout: 1 },
  { unique: true, sparse: true },
);
depositSchema.index({ baseAddress: 1, createdAt: -1 });
depositSchema.index({ fairAddress: 1, createdAt: 1 });
depositSchema.index({ status: 1, createdAt: -1 });
depositSchema.index({ clientIp: 1, status: 1 });

export type DepositDoc = InferSchemaType<typeof depositSchema> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export const Deposit: Model<DepositDoc> =
  (mongoose.models.Deposit as Model<DepositDoc> | undefined) ??
  mongoose.model<DepositDoc>("Deposit", depositSchema);
