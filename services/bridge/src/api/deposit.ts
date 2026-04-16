import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import mongoose from "mongoose";
import { z } from "zod";
import { allocateNextDepositAddress } from "../hd/derive.js";
import { Deposit, type DepositDoc } from "../models/deposit.js";
import { validate } from "./validate.js";

const EthAddressRegex = /^0x[0-9a-fA-F]{40}$/;
const MAX_AWAITING_PER_IP = 100;

const DepositIntentBody = z
  .object({
    baseAddress: z.string().regex(EthAddressRegex, "invalid base address"),
  })
  .strict();

const DepositStatusParams = z
  .object({
    id: z
      .string()
      .refine((v) => mongoose.isValidObjectId(v), "invalid deposit id"),
  })
  .strict();

// Per-IP limiter for /intent only (status reads are cheap and idempotent).
// Each /intent allocates an HD index + DB row, so we cap aggressively to
// prevent index exhaustion / DB bloat from a single source.
const intentLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limited", reason: "too_many_intents" },
});

export const depositRouter: Router = Router();

depositRouter.post(
  "/intent",
  intentLimiter,
  validate(DepositIntentBody, "body"),
  async (req: Request, res: Response) => {
    const parsed = req.parsed as z.infer<typeof DepositIntentBody>;
    const baseAddress = parsed.baseAddress.toLowerCase();
    const clientIp = req.ip ?? null;

    if (clientIp) {
      const outstanding = await Deposit.countDocuments({
        clientIp,
        status: "AWAITING",
      });
      if (outstanding >= MAX_AWAITING_PER_IP) {
        res.status(429).json({
          error: "rate_limited",
          reason: "too_many_outstanding_awaiting",
        });
        return;
      }
    }

    const { index, address } = await allocateNextDepositAddress();
    const deposit = await Deposit.create({
      baseAddress,
      fairAddress: address,
      hdIndex: index,
      status: "AWAITING",
      amountSats: "0",
      amountWei: "0",
      fairConfirmations: 0,
      clientIp,
    });
    res.status(201).json({
      id: deposit._id.toString(),
      baseAddress,
      fairAddress: address,
      hdIndex: index,
      status: deposit.status,
    });
  },
);

depositRouter.get(
  "/status/:id",
  validate(DepositStatusParams, "params"),
  async (req: Request, res: Response) => {
    const parsed = req.parsed as z.infer<typeof DepositStatusParams>;
    const doc = await Deposit.findById(parsed.id).lean<DepositDoc | null>();
    if (!doc) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(sanitizeDeposit(doc));
  },
);

function sanitizeDeposit(doc: DepositDoc) {
  return {
    id: doc._id.toString(),
    baseAddress: doc.baseAddress,
    fairAddress: doc.fairAddress,
    status: doc.status,
    fairTxid: doc.fairTxid,
    fairVout: doc.fairVout,
    fairBlockHeight: doc.fairBlockHeight,
    fairConfirmations: doc.fairConfirmations,
    amountSats: doc.amountSats,
    amountWei: doc.amountWei,
    baseMintTxHash: doc.baseMintTxHash,
    baseMintBlockNumber: doc.baseMintBlockNumber,
    safeTxHash: doc.safeTxHash,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
