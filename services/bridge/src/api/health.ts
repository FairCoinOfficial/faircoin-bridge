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
