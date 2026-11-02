import type { Json } from './model';

const sensitive = /auth|cookie|password|passwd|secret|token|(?:api|access|private|client|signing|encryption)[-_]?key|credential|session|signature|bearer|jwt|csrf|xsrf|profile|^sid$|^sig$|^key$|email|phone|address|first[-_]?name|last[-_]?name|full[-_]?name|user[-_]?name/i;
export function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    // Query strings and fragments can contain signed credentials. Keep only the route.
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}
export function redact(value: unknown, depth = 0): Json {
  if (depth > 25) return '[Depth limit]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (value.length > 2_000_000) return '[Oversized field]';
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return redact(JSON.parse(trimmed), depth + 1); } catch { /* Preserve non-JSON text below. */ }
    }
    if (/^https?:\/\//i.test(value)) return safeUrl(value);
    if (/\bBearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\b(?:cookie|authorization|csrf|session[-_ ]?token)\s*[:=]|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) return '[REDACTED]';
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 100_000).map(item => redact(item, depth + 1));
  if (typeof value === 'object' && value) {
    const result: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      result[key] = sensitive.test(key) ? '[REDACTED]' : redact(child, depth + 1);
    }
    return result;
  }
  return null;
}
export function endpointUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Use HTTPS, or localhost HTTP for testing.');
  }
  if (url.username || url.password) throw new Error('Credentials in URLs are not supported.');
  for (const [key, value] of url.searchParams) {
    if (sensitive.test(key) || /\bBearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/i.test(value)) throw new Error('Remove credentials or sensitive query parameters from the endpoint.');
  }
  url.hash = '';
  return url;
}
