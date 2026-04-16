import { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import {
  BuybackCycle,
  type BuybackCycleDoc,
} from "../models/buyback-cycle.js";
import {
  MasternodeRewardCycle,
  type MasternodeRewardCycleDoc,
} from "../models/masternode-reward-cycle.js";
import { runOneCycle } from "../workers/buyback-worker.js";
import { runMasternodeRewardTick } from "../workers/masternode-reward-worker.js";

/**
 * Admin API.
 *
 * Currently exposes:
 *   GET  /api/admin/buyback/status               — last 10 BuybackCycle rows
 *   POST /api/admin/buyback/trigger              — synchronously runs one buyback cycle
 *   GET  /api/admin/masternode-rewards/status    — last 10 MasternodeRewardCycle rows
 *   POST /api/admin/masternode-rewards/trigger   — synchronously runs one reward cycle
 *
 * Auth: simple bearer token from `ADMIN_API_TOKEN`. The router is only
 * mounted by the API server when the token is configured; otherwise the
 * endpoints 404 (better than exposing a wide-open admin surface). The token
 * comparison is constant-time to avoid distinguishing length/prefix mismatches
 * via timing.
 */

const STATUS_LIMIT = 10;

function isAdminEnabled(): boolean {
  return Boolean(config.ADMIN_API_TOKEN);
}

function bytesEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isAdminEnabled()) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const header = req.headers.authorization ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const presented = header.slice(prefix.length);
  const expected = config.ADMIN_API_TOKEN ?? "";
  if (!bytesEq(presented, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

// Per-IP rate limit for the admin trigger to limit the blast radius if a
// token leaks. The status endpoint shares the same router-level limit.
const adminLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

interface SerializedCycle {
  id: string;
  status: string;
  triggeredAt: string;
  usdcAmount: string;
  swapTxHash: string | null;
  wfairAcquiredWei: string | null;
  burnTxHash: string | null;
  treasuryTxHash: string | null;
  masternodeTxHash: string | null;
  burnAmountWei: string | null;
  treasuryAmountWei: string | null;
  masternodeAmountWei: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

function serializeCycle(doc: BuybackCycleDoc): SerializedCycle {
  return {
    id: doc._id.toString(),
    status: doc.status,
    triggeredAt: doc.triggeredAt.toISOString(),
    usdcAmount: doc.usdcAmount,
    swapTxHash: doc.swapTxHash ?? null,
    wfairAcquiredWei: doc.wfairAcquiredWei ?? null,
    burnTxHash: doc.burnTxHash ?? null,
    treasuryTxHash: doc.treasuryTxHash ?? null,
    masternodeTxHash: doc.masternodeTxHash ?? null,
    burnAmountWei: doc.burnAmountWei ?? null,
    treasuryAmountWei: doc.treasuryAmountWei ?? null,
    masternodeAmountWei: doc.masternodeAmountWei ?? null,
    errorMessage: doc.errorMessage ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

const TriggerBody = z.object({}).strict().optional();

export const adminRouter: Router = Router();

adminRouter.use(adminLimiter);
adminRouter.use(authMiddleware);

adminRouter.get(
  "/buyback/status",
  async (_req: Request, res: Response): Promise<void> => {
    const rows = await BuybackCycle.find()
      .sort({ createdAt: -1 })
      .limit(STATUS_LIMIT)
      .lean<BuybackCycleDoc[]>();
    res.json({ cycles: rows.map(serializeCycle) });
  },
);

adminRouter.post(
  "/buyback/trigger",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = TriggerBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
      return;
    }
    if (!config.BUYBACK_ENABLED) {
      res.status(409).json({
        error: "buyback_disabled",
        message: "Set BUYBACK_ENABLED=true and restart before triggering cycles",
      });
      return;
    }
    try {
      const cycle = await runOneCycle();
      if (!cycle) {
        res.status(202).json({
          triggered: false,
          message:
            "USDC balance below BUYBACK_THRESHOLD_USDC; no cycle started",
        });
        return;
      }
      res.status(200).json({ triggered: true, cycle: serializeCycle(cycle) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "admin buyback trigger failed");
      res.status(500).json({ error: "trigger_failed", message });
    }
  },
);

// ── Masternode reward booster (task #29) ──────────────────────────────────
//
// Status & manual-trigger endpoints, structurally mirroring the buyback
// pair above. The trigger endpoint is synchronous: a cycle is bounded by
// `# masternodes × per-payout RPC latency`, which is small enough that a
// request-time wait is acceptable and gives the operator immediate feedback.

interface SerializedMasternodePayout {
  masternodeOutpoint: string;
  payoutAddress: string;
  amountSats: string;
  status: string;
  txid: string | null;
  errorMessage: string | null;
}

interface SerializedMasternodeCycle {
  id: string;
  status: string;
  triggeredAt: string;
  poolBalanceSats: string;
  activeMasternodes: number;
  perMasternodeSats: string;
  payouts: SerializedMasternodePayout[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

function serializeMasternodeCycle(
  doc: MasternodeRewardCycleDoc,
): SerializedMasternodeCycle {
  return {
    id: doc._id.toString(),
    status: doc.status,
    triggeredAt: doc.triggeredAt.toISOString(),
    poolBalanceSats: doc.poolBalanceFair,
    activeMasternodes: doc.activeMasternodes,
    perMasternodeSats: doc.perMasternodeFair,
    payouts: doc.payouts.map((p) => ({
      masternodeOutpoint: p.masternodeOutpoint,
      payoutAddress: p.payoutAddress,
      amountSats: p.amountSats,
      status: p.status,
      txid: p.txid ?? null,
      errorMessage: p.errorMessage ?? null,
    })),
    errorMessage: doc.errorMessage ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

adminRouter.get(
  "/masternode-rewards/status",
  async (_req: Request, res: Response): Promise<void> => {
    const rows = await MasternodeRewardCycle.find()
      .sort({ createdAt: -1 })
      .limit(STATUS_LIMIT)
      .lean<MasternodeRewardCycleDoc[]>();
    res.json({
      enabled: config.MASTERNODE_REWARDS_ENABLED,
      intervalMs: config.MASTERNODE_REWARDS_INTERVAL_MS,
      minBalanceFair: config.MASTERNODE_REWARDS_MIN_BALANCE_FAIR,
      payoutFeeFair: config.MASTERNODE_REWARDS_PAYOUT_FEE_FAIR,
      poolAddress: config.FAIR_MASTERNODE_REWARD_ADDRESS ?? null,
      cycles: rows.map(serializeMasternodeCycle),
    });
  },
);

adminRouter.post(
  "/masternode-rewards/trigger",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = TriggerBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
      return;
    }
    if (!config.MASTERNODE_REWARDS_ENABLED) {
      res.status(409).json({
        error: "masternode_rewards_disabled",
        message:
          "Set MASTERNODE_REWARDS_ENABLED=true and restart before triggering cycles",
      });
      return;
    }
    try {
      await runMasternodeRewardTick();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "admin masternode-rewards trigger failed");
      res.status(500).json({ error: "trigger_failed", message });
      return;
    }
    const latest = await MasternodeRewardCycle.findOne()
      .sort({ createdAt: -1 })
      .lean<MasternodeRewardCycleDoc | null>();
    res.status(200).json({
      triggered: true,
      latestCycle: latest ? serializeMasternodeCycle(latest) : null,
    });
  },
);
