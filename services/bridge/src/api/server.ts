import http from "node:http";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { depositRouter } from "./deposit.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { healthRoute } from "./health.js";
import { reservesRouter } from "./reserves.js";
import { withdrawalRouter } from "./withdrawal.js";

// Bind to loopback in production: nginx on the droplet terminates TLS and
// proxies to us. Exposing the API on 0.0.0.0 is unnecessary and widens the
// attack surface.
const LISTEN_HOST = "127.0.0.1";

export async function startApi(): Promise<http.Server> {
  const app = express();

  // Cloudflare and the droplet nginx add X-Forwarded-For. One hop: trust
  // exactly one proxy, never `true` (which is spoofable).
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(express.json({ limit: "100kb" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (config.API_CORS_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", config.API_CORS_ORIGIN);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/health", (req, res, next) => {
    healthRoute(req, res).catch(next);
  });
  app.use("/api/bridge/deposit", depositRouter);
  app.use("/api/bridge/withdrawal", withdrawalRouter);
  app.use("/api/bridge/reserves", reservesRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return await new Promise<http.Server>((resolve) => {
    const server = app.listen(config.PORT, LISTEN_HOST, () => {
      logger.info({ host: LISTEN_HOST, port: config.PORT }, "api listening");
      resolve(server);
    });
  });
}
