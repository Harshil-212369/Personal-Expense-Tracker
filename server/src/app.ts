import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import { pino } from 'pino';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { AiGateway } from './ai/gateway.ts';
import type { Config } from './config.ts';
import type { Db } from './db/database.ts';
import { apiNotFound, bearerAuth, errorHandler, localOnlyGuard, requestId } from './http/middleware.ts';
import { apiRouter } from './http/routes.ts';

export interface AppDeps {
  db: Db;
  config: Config;
  ai: AiGateway | null;
  logger?: Logger;
}

const VERSION = (
  JSON.parse(readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8')) as { version: string }
).version;

export function createLogger(config: Pick<Config, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    base: null, // no hostname or pid: nothing about the machine belongs in the log
    // Defence in depth: even if a header or body were logged by mistake, these never reach the log.
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.apiToken', '*.anthropicApiKey'], remove: true },
  });
}

/**
 * Builds the Express app from its dependencies. Nothing here reads the
 * environment or opens a socket, so tests construct an app around an in-memory
 * database and a stub AI gateway.
 */
export function createApp({ db, config, ai, logger = createLogger(config) }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => (res as express.Response).locals['requestId'] as string,
      // Log the route and outcome only. Query strings can hold search terms
      // and bodies hold financial data, so neither is ever written to the log.
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, path: req.url.split('?')[0] }),
        res: (res: { statusCode: number }) => ({ status: res.statusCode }),
      },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null, // served over plain HTTP on localhost
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      strictTransportSecurity: false,
    }),
  );
  app.use(localOnlyGuard(config));

  const api = express.Router();
  // Responses contain personal financial data: never cache them.
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(express.json({ limit: '100kb' }));
  api.use((req, res, next) => (req.path === '/health' ? next() : bearerAuth(config.apiToken)(req, res, next)));
  api.use(apiRouter({ db, config, ai, version: VERSION }));
  api.use(apiNotFound);
  app.use('/api', api);

  if (config.webDist) {
    app.use(express.static(config.webDist, { index: 'index.html', maxAge: '1h' }));
    // Single-page app: any other GET is a client-side route.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(config.webDist!, 'index.html'));
    });
  }

  app.use(errorHandler(logger));
  return app;
}
