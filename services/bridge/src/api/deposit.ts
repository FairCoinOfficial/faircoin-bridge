import { Router, type Request, type Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Deposit, type DepositDoc } from "../models/deposit.js";
import { validate } from "./validate.js";

const EthAddressRegex = /^0x[0-9a-fA-F]{40}$/;

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

export const depositRouter: Router = Router();

depositRouter.post(
  "/intent",
  validate(DepositIntentBody, "body"),
  (_req: Request, res: Response) => {
    // HD derivation + deposit address allocation lands in a follow-up PR
    // once the FAIR RPC + HD modules are available.
    res.status(501).json({ error: "not_implemented" });
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
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
