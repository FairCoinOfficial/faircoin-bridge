import http from "node:http";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { adminRouter } from "./admin.js";
import { buyRouter } from "./buy.js";
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

  // CORS — `API_CORS_ORIGIN` is a comma-separated allowlist (e.g.
  // "https://fairco.in,https://oxy.so"). The browser-facing
  // `Access-Control-Allow-Origin` header MUST be either `*` or a single
  // origin string per the Fetch spec; comma-separated values are rejected by
  // every modern browser. We echo back the request's `Origin` header only
  // when it matches the allowlist, and add `Vary: Origin` so caches don't
  // serve a response keyed on the wrong origin.
  const allowedOrigins = (config.API_CORS_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const allowedOriginSet = new Set<string>(allowedOrigins);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (allowedOriginSet.size > 0) {
      const requestOrigin = req.headers.origin;
      if (typeof requestOrigin === "string" && allowedOriginSet.has(requestOrigin)) {
        res.setHeader("Access-Control-Allow-Origin", requestOrigin);
        res.setHeader("Vary", "Origin");
      }
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
  // Buy-FAIR endpoints. Mounted at /api/buy/* per the FAIRWallet contract;
  // bridge/* prefix would couple the consumer-facing path to internal routing.
  app.use("/api/buy", buyRouter);
  // Admin endpoints (buyback trigger / status). The router self-disables
  // when ADMIN_API_TOKEN is unset, returning 404 on every request.
  app.use("/api/admin", adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return await new Promise<http.Server>((resolve) => {
    const server = app.listen(config.PORT, LISTEN_HOST, () => {
      logger.info({ host: LISTEN_HOST, port: config.PORT }, "api listening");
      resolve(server);
    });
  });
}
