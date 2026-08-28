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
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GhlApiError';
  }
}

export interface GhlClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

const MAX_RETRY_DELAY_MS = 5_000;

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
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    return { payload: params, contentType: 'application/x-www-form-urlencoded' };
  }
  // multipart: fetch sets the boundary header itself, so leave contentType undefined.
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return { payload: form };
}

export class GhlClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GhlClientOptions) {
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
      const retryAfter = Number(response.headers.get('retry-after') ?? 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, MAX_RETRY_DELAY_MS)));
      return this.request(req, attempt + 1);
    }

    if (!response.ok) {
      throw new GhlApiError(response.status, extractMessage(data, `${response.status} ${response.statusText}`), data);
    }
    return data === '' ? { ok: true } : data;
  }
}
