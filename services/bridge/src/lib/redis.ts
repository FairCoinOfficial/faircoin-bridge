import IORedis, { type Redis } from "ioredis";
import { config } from "../config.js";
import { logger } from "./logger.js";

let client: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;
  const instance = new IORedis(config.REDIS_URL, {
    // BullMQ requires this; also safer for our use (no implicit queueing).
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  instance.on("connect", () => {
    logger.info({ url: redactUrl(config.REDIS_URL) }, "redis connected");
  });
  instance.on("error", (err: unknown) => {
    logger.error({ err }, "redis error");
  });
  instance.on("end", () => {
    logger.warn("redis connection ended");
  });
  client = instance;
  return instance;
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    if (parsed.username) parsed.username = "***";
    return parsed.toString();
  } catch {
    return "redis://[unparseable-url]";
  }
}
