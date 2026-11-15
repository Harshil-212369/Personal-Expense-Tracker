import { existsSync } from 'node:fs';
import { createAnthropicGateway } from './ai/gateway.ts';
import { createApp, createLogger } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/database.ts';

// Load .env when present (it is git-ignored). Real environment variables win.
for (const file of ['.env', '../.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const config = loadConfig();
const logger = createLogger(config);
const db = openDatabase(config.databasePath);
const ai = createAnthropicGateway(config);
const app = createApp({ db, config, ai, logger });

const server = app.listen(config.port, config.host, () => {
  logger.info(
    { host: config.host, port: config.port, ai: ai ? ai.model : 'disabled', auth: config.apiToken ? 'token' : 'none', ui: Boolean(config.webDist) },
    `LedgerLens API listening on http://${config.host}:${config.port}`,
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
