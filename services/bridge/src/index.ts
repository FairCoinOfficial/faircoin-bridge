import "dotenv/config";
import mongoose from "mongoose";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { connectMongo } from "./lib/mongo.js";
import { getRedis } from "./lib/redis.js";
import { startApi } from "./api/server.js";

async function main(): Promise<void> {
  logger.info({ env: config.NODE_ENV }, "faircoin-bridge starting");
  await connectMongo();

  const redis = getRedis();
  await redis.ping();

  const server = await startApi();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown starting");
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await mongoose.disconnect();
    await redis.quit();
    logger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err: unknown) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
