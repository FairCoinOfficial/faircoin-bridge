import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

// All bigint-ish fields stored as strings — see deposit.ts for rationale.
const reservesSnapshotSchema = new Schema(
  {
    at: { type: Date, required: true, default: () => new Date() },
    fairCustodySats: { type: String, required: true },
    wfairSupplyWei: { type: String, required: true },
    deltaSats: { type: String, required: true },
    pegHealthy: { type: Boolean, required: true },
  },
  { collection: "reserves" },
);

reservesSnapshotSchema.index({ at: -1 });

export type ReservesSnapshotDoc = InferSchemaType<
  typeof reservesSnapshotSchema
> & {
  _id: mongoose.Types.ObjectId;
};

export const ReservesSnapshot: Model<ReservesSnapshotDoc> =
  (mongoose.models.ReservesSnapshot as
    | Model<ReservesSnapshotDoc>
    | undefined) ??
  mongoose.model<ReservesSnapshotDoc>(
    "ReservesSnapshot",
    reservesSnapshotSchema,
  );
