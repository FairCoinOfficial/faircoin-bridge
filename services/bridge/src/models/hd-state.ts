import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const HD_STATE_IDS = ["fair_deposit"] as const;
export type HdStateId = (typeof HD_STATE_IDS)[number];

const hdStateSchema = new Schema(
  {
    _id: { type: String, enum: HD_STATE_IDS, required: true },
    nextIndex: { type: Number, required: true, default: 0 },
  },
  {
    timestamps: { createdAt: false, updatedAt: true },
    collection: "hd_state",
    _id: false,
  },
);

export type HdStateDoc = InferSchemaType<typeof hdStateSchema> & {
  _id: HdStateId;
  updatedAt: Date;
};

export const HdState: Model<HdStateDoc> =
  (mongoose.models.HdState as Model<HdStateDoc> | undefined) ??
  mongoose.model<HdStateDoc>("HdState", hdStateSchema);
