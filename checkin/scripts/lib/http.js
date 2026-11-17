/** Tiny fetch wrapper: timeout, bounded retries, JSON-or-text decoding. */
import { sleep } from './util.js';

export async function fetchJson(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20000,
    retries = 2,
    retryOn = (r) => r.status === 429 || r.status >= 500,
  } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw new Error(`网络请求失败：${e && e.message ? e.message : e}`);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON response */
    }
    const out = { status: res.status, ok: res.ok, json, text };
    if (!res.ok && retryOn(out) && attempt < retries) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    return out;
  }
  throw lastErr || new Error('请求失败');
}
