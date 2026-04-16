import type { Request, Response } from "express";
import mongoose from "mongoose";
import { getRedis } from "../lib/redis.js";

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

  const ok = mongoOk && redisOk;
  res.status(ok ? 200 : 503).json({ ok, uptimeSec, mongoOk, redisOk });
}
