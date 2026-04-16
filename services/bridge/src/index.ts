// MUST be the first import: monkey-patches Express 4 so async route handlers
// forward rejected Promises to the error middleware. Without it, an async
// throw silently hangs the request until the client times out.
import "express-async-errors";
import "dotenv/config";
import mongoose from "mongoose";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { connectMongo } from "./lib/mongo.js";
import { getRedis } from "./lib/redis.js";
import { startApi } from "./api/server.js";
import { createMintQueue, createReleaseQueue } from "./queues.js";
import { startFairWatcher } from "./workers/fair-watcher.js";
import { startBaseWatcher } from "./workers/base-watcher.js";
import {
  startMintWorker,
  startReleaseWorker,
} from "./workers/orchestrator.js";
import { startReservesSnapshot } from "./workers/reserves-snapshot.js";

async function main(): Promise<void> {
  logger.info({ env: config.NODE_ENV }, "faircoin-bridge starting");
  await connectMongo();

  const redis = getRedis();
  await redis.ping();

  const server = await startApi();

  const mintQueue = createMintQueue();
  const releaseQueue = createReleaseQueue();

  const controller = new AbortController();
  const watcherPromises: Promise<void>[] = [
    startFairWatcher(controller.signal),
    startBaseWatcher(controller.signal),
    startReservesSnapshot(controller.signal),
  ];
  const mintWorker = startMintWorker(controller.signal);
  const releaseWorker = startReleaseWorker(controller.signal);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown starting");
    controller.abort();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    await Promise.allSettled(watcherPromises);
    await Promise.allSettled([mintWorker.close(), releaseWorker.close()]);
    await Promise.allSettled([mintQueue.close(), releaseQueue.close()]);

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
