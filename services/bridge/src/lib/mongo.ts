import mongoose from "mongoose";
import { config } from "../config.js";
import { logger } from "./logger.js";

let connected = false;

export async function connectMongo(): Promise<typeof mongoose> {
  if (connected) return mongoose;

  const autoIndex = config.NODE_ENV !== "production";
  if (!autoIndex) {
    logger.info(
      "mongo autoIndex disabled in production; run the index creation script to ensure indexes exist",
    );
  }

  mongoose.connection.on("connected", () => {
    logger.info({ uri: redactUri(config.MONGO_URI) }, "mongo connected");
  });
  mongoose.connection.on("disconnected", () => {
    logger.warn("mongo disconnected");
  });
  mongoose.connection.on("error", (err: unknown) => {
    logger.error({ err }, "mongo error");
  });

  await mongoose.connect(config.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    autoIndex,
  });
  await runStartupMigrations();
  connected = true;
  return mongoose;
}

/**
 * One-shot startup migrations. Idempotent: each step checks whether the
 * change is already in place before mutating. Safe to run on every boot.
 */
async function runStartupMigrations(): Promise<void> {
  await dropLegacyDepositFairAddressUniqueIndex();
}

/**
 * Originally `Deposit.fairAddress` had a unique index. Dropped because users
 * naturally re-send to the same deposit address after a prior mint settles
 * and we now create a fresh document per (fairTxid, fairVout). Old droplets
 * will still have the legacy index — drop it on boot once.
 */
async function dropLegacyDepositFairAddressUniqueIndex(): Promise<void> {
  const conn = mongoose.connection;
  if (!conn.db) return;
  const collection = conn.db.collection("deposits");
  let indexes: Array<{ name?: string; unique?: boolean; key: Record<string, unknown> }>;
  try {
    indexes = await collection.indexes();
  } catch (err: unknown) {
    logger.warn({ err }, "could not list deposits indexes; skipping migration");
    return;
  }
  const legacy = indexes.find(
    (idx) =>
      idx.unique === true &&
      Object.keys(idx.key).length === 1 &&
      idx.key.fairAddress === 1,
  );
  if (!legacy?.name) return;
  try {
    await collection.dropIndex(legacy.name);
    logger.warn(
      { indexName: legacy.name },
      "dropped legacy unique index on deposits.fairAddress (re-use is now allowed)",
    );
  } catch (err: unknown) {
    logger.error(
      { err, indexName: legacy.name },
      "failed to drop legacy unique index on deposits.fairAddress",
    );
  }
}

function redactUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.password) parsed.password = "***";
    if (parsed.username) parsed.username = "***";
    return parsed.toString();
  } catch {
    return "mongo://[unparseable-uri]";
  }
}
