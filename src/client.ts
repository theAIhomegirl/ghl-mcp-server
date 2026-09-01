import type { BodyContentType, HttpMethod } from './generator/openapi.ts';

export interface GhlRequest {
  method: HttpMethod;
  path: string;
  version: string;
  pathParams?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  contentType?: BodyContentType;
}

export class GhlApiError extends Error {
  // Declared and assigned explicitly rather than as constructor parameter
  // properties: Node's type stripping (npm run dev) cannot erase those.
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'GhlApiError';
    this.status = status;
    this.details = details;
  }
}

export interface GhlClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

const MAX_RETRY_DELAY_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

/** A base64 file part. Binary body fields accept this shape; see the generated schemas. */
export interface Base64File {
  base64: string;
  filename?: string;
  contentType?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBase64File(value: unknown): value is Base64File {
  return isRecord(value) && typeof value.base64 === 'string';
}

/**
 * RFC 9110 allows Retry-After to be either a delay in seconds or an HTTP-date.
 * Feeding the date straight to Number() yields NaN, and setTimeout(NaN) fires
 * immediately with a runtime warning on the stdio log channel.
 */
export function retryDelayMs(header: string | null, now = Date.now()): number {
  const raw = header?.trim();
  if (!raw) return DEFAULT_RETRY_DELAY_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return clampDelay(seconds * 1000);
  const until = Date.parse(raw);
  if (Number.isNaN(until)) return DEFAULT_RETRY_DELAY_MS;
  return clampDelay(until - now);
}

function clampDelay(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_RETRY_DELAY_MS);
}

function extractMessage(payload: unknown, fallback: string): string {
  if (typeof payload === 'object' && payload !== null && 'message' in payload) {
    const message = (payload as { message: unknown }).message;
    if (Array.isArray(message)) return message.join('; ');
    if (typeof message === 'string') return message;
  }
  return fallback;
}

function appendQuery(url: URL, query: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, String(item)));
    } else if (typeof value === 'object') {
      url.searchParams.set(key, JSON.stringify(value));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

function encodeBody(body: unknown, contentType: BodyContentType): { payload: NonNullable<RequestInit['body']>; contentType?: string } {
  if (contentType === 'application/json') {
    return { payload: JSON.stringify(body), contentType: 'application/json' };
  }
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (contentType === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      // Arrays repeat the key, matching how they are sent in the query string.
      if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
      else params.set(key, isRecord(value) ? JSON.stringify(value) : String(value));
    }
    return { payload: params, contentType: 'application/x-www-form-urlencoded' };
  }
  // multipart: fetch sets the boundary header itself, so leave contentType undefined.
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Blob) {
      form.set(key, value);
    } else if (isBase64File(value)) {
      // String(value) here would upload the literal text "[object Object]".
      const blob = new Blob([Buffer.from(value.base64, 'base64')], {
        type: value.contentType ?? 'application/octet-stream',
      });
      form.set(key, blob, value.filename ?? key);
    } else if (Array.isArray(value)) {
      value.forEach((item) => form.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item)));
    } else {
      form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
  }
  return { payload: form };
}

export class GhlClient {
  private readonly options: GhlClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GhlClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  buildUrl(path: string, pathParams: Record<string, unknown> = {}, query: Record<string, unknown> = {}): URL {
    const resolvedPath = path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const value = pathParams[name];
      if (value === undefined || value === null || value === '') {
        throw new GhlApiError(400, `Missing required path parameter "${name}" for ${path}`);
      }
      return encodeURIComponent(String(value));
    });
    const url = new URL(`${this.options.baseUrl}${resolvedPath}`);
    appendQuery(url, query);
    return url;
  }

  async request(req: GhlRequest, attempt = 0): Promise<unknown> {
    const url = this.buildUrl(req.path, req.pathParams, req.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      Version: req.version,
      Accept: 'application/json',
    };
    let payload: RequestInit['body'];
    if (req.body !== undefined && req.method !== 'GET') {
      const encoded = encodeBody(req.body, req.contentType ?? 'application/json');
      payload = encoded.payload;
      if (encoded.contentType) headers['Content-Type'] = encoded.contentType;
    }

    const response = await this.fetchImpl(url, { method: req.method, headers, body: payload });
    const text = await response.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // Non-JSON bodies (rare) are returned as-is.
      }
    }

    if (response.status === 429 && attempt === 0) {
      const delay = retryDelayMs(response.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.request(req, attempt + 1);
    }

    if (!response.ok) {
      throw new GhlApiError(response.status, extractMessage(data, `${response.status} ${response.statusText}`), data);
    }
    return data === '' ? { ok: true } : data;
  }
}
