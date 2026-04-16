import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.js";

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "not_found" });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logger.error(
    { err, method: req.method, path: req.path },
    "unhandled api error",
  );
  if (res.headersSent) return;
  res.status(500).json({ error: "internal" });
}
