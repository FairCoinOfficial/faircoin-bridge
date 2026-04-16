import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const AUDIT_LOG_KINDS = [
  "SIGN_MINT",
  "SIGN_RELEASE",
  "PAUSE",
  "UNPAUSE",
  "CAP_CHANGE",
  "ALERT",
  "BUY_ORCHESTRATOR",
] as const;
export type AuditLogKind = (typeof AUDIT_LOG_KINDS)[number];

const auditLogSchema = new Schema(
  {
    kind: { type: String, enum: AUDIT_LOG_KINDS, required: true },
    actor: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true, default: {} },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: "audit_log",
  },
);

auditLogSchema.index({ kind: 1, createdAt: -1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema> & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  payload: Record<string, unknown>;
};

export const AuditLog: Model<AuditLogDoc> =
  (mongoose.models.AuditLog as Model<AuditLogDoc> | undefined) ??
  mongoose.model<AuditLogDoc>("AuditLog", auditLogSchema);
