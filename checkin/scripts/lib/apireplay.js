/**
 * Generic HTTP API replay — the escape hatch for check-ins that only run inside a
 * WeChat mini program or an app. Capture the request once (WeChat DevTools, Reqable,
 * Charles, or checkin_browser capture), then replay it here with templating so the
 * coordinates / student id / timestamps are substituted per run.
 *
 * Body/URL templating tokens:
 *   {{lat}} {{lng}} {{student}} {{name}} {{ts}} (seconds) {{ts_ms}} {{random}} {{date}}
 *   plus any custom key from `vars`.
 */
import { fetchJson } from './http.js';
import { getToken } from './creds.js';
import { wgs84ToGcj02 } from './geo.js';

function fillTemplate(input, vars) {
  if (typeof input !== 'string') return input;
  return input.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

export function buildVars(opts = {}) {
  const now = new Date();
  const vars = {
    ts: Math.floor(now.getTime() / 1000),
    ts_ms: now.getTime(),
    date: now.toISOString().slice(0, 10),
    random: Math.floor(Math.random() * 1e9),
    ...(opts.vars || {}),
  };
  if (opts.lat != null && opts.lng != null) {
    let lat = Number(opts.lat);
    let lng = Number(opts.lng);
    if (opts.coordsAreWgs84) {
      const g = wgs84ToGcj02(lat, lng);
      lat = g.latitude;
      lng = g.longitude;
    }
    vars.lat = lat;
    vars.lng = lng;
    vars.latitude = lat;
    vars.longitude = lng;
  }
  if (opts.student != null) vars.student = String(opts.student);
  if (opts.name != null) vars.name = String(opts.name);
  if (opts.address != null) vars.address = String(opts.address);
  return vars;
}

function normalizeHeaders(h, vars) {
  const out = {};
  if (!h) return out;
  if (typeof h === 'string') {
    // "Key: Value\nKey2: Value2" or a JSON string
    const trimmed = h.trim();
    if (trimmed.startsWith('{')) {
      try {
        return normalizeHeaders(JSON.parse(trimmed), vars);
      } catch {
        /* fall through */
      }
    }
    for (const line of trimmed.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = fillTemplate(line.slice(i + 1).trim(), vars);
    }
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k] = fillTemplate(String(v), vars);
  return out;
}

/**
 * @returns {{ok:boolean, status:number, json:any, text:string, request:{method,url,bodyPreview}, verify?:any}}
 */
export async function replay(ctx, opts = {}) {
  const { method = 'POST', url, headers, body, tokenFrom, tokenHeader = 'Authorization', timeoutMs = 20000 } = opts;
  if (!url) throw new Error('缺少 url');
  const vars = buildVars(opts);
  const finalUrl = fillTemplate(url, vars);
  const h = normalizeHeaders(headers, vars);

  if (tokenFrom) {
    const token = await getToken(ctx, tokenFrom);
    if (token) h[tokenHeader] = token;
  }

  let payload = body;
  if (typeof payload === 'string') payload = fillTemplate(payload, vars);
  else if (payload && typeof payload === 'object') payload = fillTemplate(JSON.stringify(payload), vars);

  const upper = String(method).toUpperCase();
  let res;
  if (upper === 'GET' || upper === 'HEAD') {
    res = await fetchJson(finalUrl, { method: upper, headers: h, timeoutMs });
  } else {
    if (payload !== undefined && !h['Content-Type'] && !h['content-type']) h['Content-Type'] = 'application/json';
    res = await fetchJson(finalUrl, { method: upper, headers: h, body: payload, timeoutMs });
  }

  const out = {
    ok: res.ok,
    status: res.status,
    json: res.json,
    text: typeof res.text === 'string' ? res.text.slice(0, 4000) : res.text,
    request: { method: upper, url: finalUrl, bodyPreview: typeof payload === 'string' ? payload.slice(0, 800) : undefined },
  };

  if (opts.verify && (opts.verify.url || opts.verify === true)) {
    const v = opts.verify === true ? {} : opts.verify;
    const vUrl = fillTemplate(v.url || finalUrl, vars);
    const vHeaders = normalizeHeaders(v.headers || headers, vars);
    if (tokenFrom) {
      const token = await getToken(ctx, tokenFrom);
      if (token) vHeaders[tokenHeader] = token;
    }
    const vMethod = String(v.method || 'GET').toUpperCase();
    let vPayload = v.body;
    if (typeof vPayload === 'string') vPayload = fillTemplate(vPayload, vars);
    else if (vPayload && typeof vPayload === 'object') vPayload = fillTemplate(JSON.stringify(vPayload), vars);
    const vr = await fetchJson(vUrl, { method: vMethod, headers: vHeaders, body: vMethod === 'GET' ? undefined : vPayload, timeoutMs });
    const vText = typeof vr.text === 'string' ? vr.text : '';
    let passed;
    if (v.successContains) passed = vText.includes(v.successContains);
    let extracted;
    if (v.successPath && vr.json) {
      extracted = v.successPath.split('.').reduce((o, k) => (o == null ? o : o[k]), vr.json);
    }
    out.verify = { status: vr.status, ok: vr.ok, passed: passed ?? undefined, extracted, text: vText.slice(0, 2000) };
  }

  return out;
}
