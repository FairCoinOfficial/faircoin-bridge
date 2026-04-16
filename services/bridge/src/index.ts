import { startApi } from "./api/server.js";
import { logger } from "./lib/logger.js";

async function main() {
  logger.info("faircoin-bridge starting");
  await startApi();
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
