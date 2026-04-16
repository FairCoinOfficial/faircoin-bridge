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
  connected = true;
  return mongoose;
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
