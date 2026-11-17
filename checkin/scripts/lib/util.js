/** Small shared helpers for the checkin plugin. */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Coerce to a finite number, or undefined for empty/invalid input. */
export function num(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function ok(data = {}) {
  return { ok: true, ...data };
}

export function fail(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

/** Human/model friendly rendering of an arbitrary result value. */
export function renderText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
export const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** Truncate a string for safe logging. */
export function clip(s, n = 300) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}
