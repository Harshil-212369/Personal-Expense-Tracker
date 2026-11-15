import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import type { Logger } from 'pino';
import type { z } from 'zod';
import type { Config } from '../config.ts';
import { badRequest, HttpError, toProblem, unauthorized } from '../lib/errors.ts';
import { safeEqual } from '../lib/hash.ts';

/** Parses untrusted input against a schema, turning failures into a 400 with per-field messages. */
export function validate<Schema extends z.ZodType>(schema: Schema, data: unknown): z.infer<Schema> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw badRequest(
    'The request did not match the expected shape.',
    result.error.issues.map((issue) => ({ field: issue.path.join('.') || '(root)', message: issue.message })),
  );
}

export function parseId(value: unknown, what: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw badRequest(`${what} id must be a positive integer.`);
  return id;
}

export const requestId: RequestHandler = (req, res, next) => {
  const id = randomUUID();
  res.locals['requestId'] = id;
  res.setHeader('X-Request-Id', id);
  next();
};

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostnameOf(hostHeader: string): string {
  return hostHeader.replace(/:\d+$/, '').toLowerCase();
}

/**
 * Protects a localhost API from web pages the user happens to visit.
 *
 *  - DNS rebinding: when bound to loopback, only accept requests whose Host
 *    header is a loopback name. A hostile domain that resolves to 127.0.0.1
 *    still sends its own name in Host and is refused.
 *  - CSRF: a state-changing request that carries an Origin header must come
 *    from the same origin. Browsers always attach Origin to cross-site
 *    POST/PATCH/DELETE, so another site cannot post a file into the ledger.
 */
export function localOnlyGuard(config: Pick<Config, 'host'>): RequestHandler {
  const boundToLoopback = LOOPBACK_HOSTNAMES.has(config.host) || config.host === '::1';
  return (req, _res, next) => {
    const host = req.headers.host ?? '';
    if (boundToLoopback && !LOOPBACK_HOSTNAMES.has(hostnameOf(host))) {
      return next(new HttpError(403, 'forbidden-host', 'This API only answers requests addressed to localhost.'));
    }
    const origin = req.headers.origin;
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        /* malformed Origin is treated as a mismatch */
      }
      if (originHost !== host) {
        return next(new HttpError(403, 'cross-origin', 'Cross-origin requests are not allowed.'));
      }
    }
    next();
  };
}

/** Optional bearer-token auth, required whenever the server listens beyond loopback. */
export function bearerAuth(token: string | undefined): RequestHandler {
  return (req, _res, next) => {
    if (!token) return next();
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !safeEqual(presented, token)) return next(unauthorized());
    next();
  };
}

export function apiNotFound(req: Request, _res: Response, next: NextFunction): void {
  next(new HttpError(404, 'not-found', `No API route matches ${req.method} ${req.path}.`));
}

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifies error middleware by its four-argument signature.
  return (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestIdValue = res.locals['requestId'] as string | undefined;
    const send = (status: number, code: string, detail: string, errors?: unknown) => {
      res
        .status(status)
        .type('application/problem+json')
        .send(
          JSON.stringify(
            toProblem(status, code, detail, {
              instance: req.originalUrl.split('?')[0]!,
              ...(requestIdValue ? { requestId: requestIdValue } : {}),
              ...(errors === undefined ? {} : { errors }),
            }),
          ),
        );
    };

    if (error instanceof HttpError) return send(error.status, error.code, error.message, error.details);

    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') return send(413, 'file-too-large', 'The uploaded file is larger than the limit.');
      return send(400, 'bad-upload', 'Upload exactly one file in the "file" field.');
    }

    const bodyError = error as BodyParserError;
    if (bodyError?.type === 'entity.parse.failed') return send(400, 'bad-json', 'The request body is not valid JSON.');
    if (bodyError?.type === 'entity.too.large') return send(413, 'body-too-large', 'The request body is too large.');

    // Unexpected: log the full error server-side, return nothing internal to the client.
    logger.error({ err: error, requestId: requestIdValue }, 'unhandled error');
    send(500, 'internal', 'An unexpected error occurred.');
  };
}
