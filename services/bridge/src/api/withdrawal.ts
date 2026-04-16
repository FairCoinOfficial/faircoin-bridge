import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { Withdrawal, type WithdrawalDoc } from "../models/withdrawal.js";
import { validate } from "./validate.js";

const TxHashRegex = /^0x[0-9a-fA-F]{64}$/;

const WithdrawalStatusParams = z
  .object({
    burnTxHash: z.string().regex(TxHashRegex, "invalid tx hash"),
  })
  .strict();

export const withdrawalRouter: Router = Router();

withdrawalRouter.get(
  "/status/:burnTxHash",
  validate(WithdrawalStatusParams, "params"),
  async (req: Request, res: Response) => {
    const parsed = req.parsed as z.infer<typeof WithdrawalStatusParams>;
    const doc = await Withdrawal.findOne({
      baseBurnTxHash: parsed.burnTxHash.toLowerCase(),
    }).lean<WithdrawalDoc | null>();
    if (!doc) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(sanitizeWithdrawal(doc));
  },
);

function sanitizeWithdrawal(doc: WithdrawalDoc) {
  return {
    id: doc._id.toString(),
    baseBurnTxHash: doc.baseBurnTxHash,
    baseBlockNumber: doc.baseBlockNumber,
    logIndex: doc.logIndex,
    fromBaseAddress: doc.fromBaseAddress,
    destinationFairAddress: doc.destinationFairAddress,
    amountWei: doc.amountWei,
    amountSats: doc.amountSats,
    status: doc.status,
    fairTxid: doc.fairTxid,
    fairConfirmations: doc.fairConfirmations,
    fairBroadcastAt: doc.fairBroadcastAt
      ? doc.fairBroadcastAt.toISOString()
      : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
