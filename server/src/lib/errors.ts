/**
 * Application errors map 1:1 to RFC 9457 "problem details" responses, so every
 * failure the API returns has the same machine-readable shape.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad-request', message, details);
export const unauthorized = (message = 'A valid bearer token is required.') =>
  new HttpError(401, 'unauthorized', message);
export const notFound = (what: string) => new HttpError(404, 'not-found', `${what} was not found.`);
export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, 'conflict', message, details);
export const unprocessable = (message: string, details?: unknown) =>
  new HttpError(422, 'unprocessable', message, details);
export const serviceUnavailable = (message: string) =>
  new HttpError(503, 'service-unavailable', message);

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  requestId?: string;
  errors?: unknown;
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export function toProblem(status: number, code: string, detail: string, extra: Partial<ProblemDetails> = {}): ProblemDetails {
  return {
    type: `urn:ledgerlens:problem:${code}`,
    title: TITLES[status] ?? 'Error',
    status,
    detail,
    ...extra,
  };
}
