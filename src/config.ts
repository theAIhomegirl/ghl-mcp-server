export interface ServerConfig {
  apiKey: string;
  locationId?: string;
  baseUrl: string;
  modules: string[] | 'all';
  allowWrites: boolean;
  allowDeletes: boolean;
  metaTools: boolean;
  includeDeprecated: boolean;
}

export const DEFAULT_BASE_URL = 'https://services.leadconnectorhq.com';
export const DEFAULT_MODULES = ['contacts', 'conversations', 'opportunities', 'calendars', 'locations'];
// Every request carries the Private Integration Token, so the base URL is a
// credential destination, not a preference. Only HighLevel's own hosts qualify.
export const ALLOWED_BASE_DOMAIN = 'leadconnectorhq.com';

type Env = Record<string, string | undefined>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function normalizeModuleName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, '-');
}

export function parseModules(value: string | undefined): string[] | 'all' {
  if (value === undefined || value.trim() === '') return DEFAULT_MODULES;
  if (value.trim().toLowerCase() === 'all') return 'all';
  return [...new Set(value.split(',').map(normalizeModuleName).filter(Boolean))];
}

export function parseBaseUrl(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`GHL_BASE_URL is not a valid URL: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') {
    throw new Error(`GHL_BASE_URL must use https; got ${url.protocol}//${host}. The API token travels on every request.`);
  }
  if (host !== ALLOWED_BASE_DOMAIN && !host.endsWith(`.${ALLOWED_BASE_DOMAIN}`)) {
    throw new Error(
      `GHL_BASE_URL must stay on ${ALLOWED_BASE_DOMAIN}; got ${host}. Pointing it elsewhere hands your Private Integration Token to that host.`,
    );
  }
  return raw.replace(/\/+$/, '');
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const apiKey = env.GHL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GHL_API_KEY is not set. Create a Private Integration token in GHL (Settings -> Private Integrations) and export it, or copy .env.example to .env.',
    );
  }
  return {
    apiKey,
    locationId: env.GHL_LOCATION_ID?.trim() || undefined,
    baseUrl: parseBaseUrl(env.GHL_BASE_URL),
    modules: parseModules(env.GHL_MODULES),
    allowWrites: parseBoolean(env.GHL_ALLOW_WRITES, false),
    allowDeletes: parseBoolean(env.GHL_ALLOW_DELETES, false),
    metaTools: parseBoolean(env.GHL_META_TOOLS, true),
    includeDeprecated: parseBoolean(env.GHL_INCLUDE_DEPRECATED, false),
  };
}
