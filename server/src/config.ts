import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  HOST: z.string().min(1).default('127.0.0.1'),
  /** Defaults to <repo>/data/ledgerlens.db, which is git-ignored. A relative value resolves against the working directory. */
  DATABASE_PATH: z.string().min(1).optional(),
  API_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5-5'),
  REDACT_TERMS: z.string().optional(),
  /** Directory of the built web app. When it exists the API also serves the UI. */
  WEB_DIST: z.string().optional(),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databasePath: string;
  apiToken: string | undefined;
  logLevel: string;
  anthropicApiKey: string | undefined;
  anthropicModel: string;
  redactTerms: string[];
  webDist: string | undefined;
  maxUploadBytes: number;
}

/** Treats "" the same as unset so a blank line in .env does not enable a feature. */
function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  const apiToken = blankToUndefined(e.API_TOKEN);

  // Fail closed: this API serves personal financial data, so it must not listen
  // on a routable interface without authentication.
  if (!LOOPBACK_HOSTS.has(e.HOST) && !apiToken) {
    throw new Error(
      `Refusing to listen on non-loopback host "${e.HOST}" without API_TOKEN. ` +
        'Set API_TOKEN or use HOST=127.0.0.1.',
    );
  }
  if (apiToken && apiToken.length < 24) {
    throw new Error('API_TOKEN must be at least 24 characters.');
  }

  const defaultWebDist = path.resolve(import.meta.dirname, '../../web/dist');
  // Serve the UI only when a build is actually there; otherwise run as a pure API.
  const webDistCandidate = blankToUndefined(e.WEB_DIST) ?? defaultWebDist;
  const webDist = existsSync(path.join(webDistCandidate, 'index.html')) ? webDistCandidate : undefined;

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    databasePath: e.DATABASE_PATH ?? path.resolve(import.meta.dirname, '../../data/ledgerlens.db'),
    apiToken,
    logLevel: e.NODE_ENV === 'test' ? 'silent' : e.LOG_LEVEL,
    anthropicApiKey: blankToUndefined(e.ANTHROPIC_API_KEY),
    anthropicModel: e.ANTHROPIC_MODEL,
    redactTerms: (e.REDACT_TERMS ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length >= 3),
    webDist,
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
  };
}
