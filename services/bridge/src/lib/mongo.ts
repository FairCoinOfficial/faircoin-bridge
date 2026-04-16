import mongoose from "mongoose";
import { config } from "../config.js";
import { BuyOrder } from "../models/buy-order.js";
import { BuybackCycle } from "../models/buyback-cycle.js";
import { Deposit } from "../models/deposit.js";
import { MasternodeRewardCycle } from "../models/masternode-reward-cycle.js";
import { Withdrawal } from "../models/withdrawal.js";
import { logger } from "./logger.js";

let connected = false;

export async function connectMongo(): Promise<typeof mongoose> {
  if (connected) return mongoose;

  const autoIndex = config.NODE_ENV !== "production";

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
 *
 * Order matters: drop legacy indexes BEFORE creating new ones, so that a
 * later index that overlaps with a deprecated one (e.g. the new compound
 * index on fairAddress + createdAt vs. the old unique single-field) gets
 * a clean slate to build into.
 */
async function runStartupMigrations(): Promise<void> {
  await dropLegacyDepositFairAddressUniqueIndex();
  await ensureCriticalIndexes();
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

/**
 * Ensure schema-defined indexes exist. In production `autoIndex: false`
 * stops Mongoose from doing this on first model use; we call createIndexes
 * explicitly so the unique `(fairTxid, fairVout)` and `(baseBurnTxHash,
 * logIndex)` indexes — which underpin the idempotency invariants — are
 * present before any write happens. createIndexes is additive: existing
 * matching indexes are reused, mismatched ones are NOT dropped (use
 * syncIndexes for that, deliberately avoided here to preserve hand-tuned
 * indexes).
 */
async function ensureCriticalIndexes(): Promise<void> {
  for (const model of [
    Deposit,
    Withdrawal,
    BuyOrder,
    BuybackCycle,
    MasternodeRewardCycle,
  ]) {
    try {
      await model.createIndexes();
      logger.info(
        { collection: model.collection.collectionName },
        "ensured indexes",
      );
    } catch (err: unknown) {
      logger.error(
        { err, collection: model.collection.collectionName },
        "failed to ensure indexes (custodial integrity at risk)",
      );
    }
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
