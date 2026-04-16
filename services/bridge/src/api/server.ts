import http from "node:http";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { depositRouter } from "./deposit.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { healthRoute } from "./health.js";
import { reservesRouter } from "./reserves.js";
import { withdrawalRouter } from "./withdrawal.js";

export async function startApi(): Promise<http.Server> {
  const app = express();
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
    const server = app.listen(config.PORT, () => {
      logger.info({ port: config.PORT }, "api listening");
      resolve(server);
    });
  });
}
