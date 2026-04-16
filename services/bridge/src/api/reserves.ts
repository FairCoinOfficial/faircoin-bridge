import { Router, type Request, type Response } from "express";
import {
  ReservesSnapshot,
  type ReservesSnapshotDoc,
} from "../models/reserves-snapshot.js";

export const reservesRouter: Router = Router();

reservesRouter.get("/", async (_req: Request, res: Response) => {
  const doc = await ReservesSnapshot.findOne()
    .sort({ at: -1 })
    .lean<ReservesSnapshotDoc | null>();
  if (!doc) {
    res.status(503).json({ error: "no_snapshot_yet" });
    return;
  }
  res.json({
    at: doc.at.toISOString(),
    fairCustodySats: doc.fairCustodySats,
    wfairSupplyWei: doc.wfairSupplyWei,
    deltaSats: doc.deltaSats,
    pegHealthy: doc.pegHealthy,
  });
});
