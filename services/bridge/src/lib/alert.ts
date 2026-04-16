import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Fire-and-forget Discord webhook alert. Never throws; failures are logged.
 */
export async function alert(
  message: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  logger.warn({ alert: true, ...context }, message);
  const url = config.DISCORD_WEBHOOK_URL;
  if (!url) return;
  const content = `[bridge][${config.BASE_NETWORK}] ${message}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, statusText: res.statusText },
        "discord webhook non-2xx",
      );
    }
  } catch (err: unknown) {
    logger.warn({ err }, "discord webhook failed");
  }
}
