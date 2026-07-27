import type { Request, Response } from "express";
import mongoose from "mongoose";
import { getRedis } from "../lib/redis.js";
import { isBuyPaymentHdConfigured } from "../hd/buy-payment.js";

const startedAt = Date.now();

export async function healthRoute(
  _req: Request,
  res: Response,
): Promise<void> {
  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
  const mongoOk = mongoose.connection.readyState === 1;

  let redisOk = false;
  try {
    const pong = await getRedis().ping();
    redisOk = pong === "PONG";
  } catch {
    redisOk = false;
  }

  // Buy needs a payment-HD root to allocate a deposit address per order. It is
  // reported separately rather than folded into `ok`: without it the buy flow
  // is dead, but deposits, mints and releases all keep working, so the service
  // is degraded, not down. Folding it in would make monitoring page for a
  // healthy bridge; omitting it entirely is how this went unnoticed until a
  // user hit "Buy" and got a 503.
  const buyOk = isBuyPaymentHdConfigured();

  const ok = mongoOk && redisOk;
  res.status(ok ? 200 : 503).json({ ok, uptimeSec, mongoOk, redisOk, buyOk });
}

/**
 * Buy-specific liveness, for uptime probes that can only read a status code.
 *
 * `/health` deliberately keeps `ok` true when only the buy flow is broken —
 * deposits, mints and releases carry on, so the bridge is degraded, not down,
 * and paging on it would train operators to ignore the alert. The cost of that
 * choice is that a plain HTTP probe cannot see a buy outage at all, which is
 * exactly how buying stayed dead without anyone noticing.
 *
 * This endpoint closes that gap: 200 while buy can allocate a payment address,
 * 503 the moment it cannot. Point a monitor at it separately from `/health` so
 * the two failure modes stay distinguishable.
 */
export function buyHealthRoute(_req: Request, res: Response): void {
  const buyOk = isBuyPaymentHdConfigured();
  res.status(buyOk ? 200 : 503).json({ ok: buyOk, buyOk });
}
