import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const WITHDRAWAL_STATUSES = [
  "DETECTED",
  "CONFIRMED",
  "SIGNING",
  "BROADCAST",
  "FINAL",
  "FAILED",
] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

// amountWei/amountSats stored as strings — see deposit.ts for rationale.
const withdrawalSchema = new Schema(
  {
    baseBurnTxHash: { type: String, required: true, lowercase: true },
    baseBlockNumber: { type: Number, required: true },
    logIndex: { type: Number, required: true },
    fromBaseAddress: { type: String, required: true, lowercase: true },
    destinationFairAddress: { type: String, required: true },
    amountWei: { type: String, required: true },
    amountSats: { type: String, required: true },
    status: {
      type: String,
      enum: WITHDRAWAL_STATUSES,
      required: true,
      default: "DETECTED",
    },
    fairTxid: { type: String, default: null },
    fairConfirmations: { type: Number, required: true, default: 0 },
    fairBroadcastAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "withdrawals" },
);

withdrawalSchema.index(
  { baseBurnTxHash: 1, logIndex: 1 },
  { unique: true },
);
withdrawalSchema.index({ fromBaseAddress: 1, createdAt: -1 });
withdrawalSchema.index({ status: 1, createdAt: -1 });

export type WithdrawalDoc = InferSchemaType<typeof withdrawalSchema> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export const Withdrawal: Model<WithdrawalDoc> =
  (mongoose.models.Withdrawal as Model<WithdrawalDoc> | undefined) ??
  mongoose.model<WithdrawalDoc>("Withdrawal", withdrawalSchema);
