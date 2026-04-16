import type { NextFunction, Request, Response } from "express";
import type { ZodTypeAny } from "zod";

export type ValidateSource = "body" | "params" | "query";

export function validate(
  schema: ZodTypeAny,
  source: ValidateSource = "body",
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const input = req[source];
    const result = schema.safeParse(input);
    if (!result.success) {
      res.status(400).json({
        error: "invalid_request",
        issues: result.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
      return;
    }
    req.parsed = result.data;
    next();
  };
}
