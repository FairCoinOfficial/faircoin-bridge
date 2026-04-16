import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const EVENT_CURSOR_IDS = ["base", "faircoin"] as const;
export type EventCursorId = (typeof EVENT_CURSOR_IDS)[number];

const eventCursorSchema = new Schema(
  {
    _id: { type: String, enum: EVENT_CURSOR_IDS, required: true },
    lastProcessedBlock: { type: Number, required: true, default: 0 },
  },
  {
    timestamps: { createdAt: false, updatedAt: true },
    collection: "event_cursor",
    _id: false,
  },
);

export type EventCursorDoc = InferSchemaType<typeof eventCursorSchema> & {
  _id: EventCursorId;
  updatedAt: Date;
};

export const EventCursor: Model<EventCursorDoc> =
  (mongoose.models.EventCursor as Model<EventCursorDoc> | undefined) ??
  mongoose.model<EventCursorDoc>("EventCursor", eventCursorSchema);
