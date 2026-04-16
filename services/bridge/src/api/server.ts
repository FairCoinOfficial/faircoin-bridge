import express from "express";
import { logger } from "../lib/logger.js";

export async function startApi(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ ok: true }));
  const port = Number(process.env.PORT ?? 3100);
  app.listen(port, () => logger.info({ port }, "api listening"));
}
