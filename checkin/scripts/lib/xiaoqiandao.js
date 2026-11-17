/**
 * 小小签到 (xiaoqiandao) adapter.
 *
 * Reverse-engineered from the H5 bundle (m.xiaoqiandao.com/static/js/app.*.js) and
 * corroborated by public community scripts. Contract:
 *   - Share link: https://m.xiaoqiandao.com/detail?cid=<24-hex ObjectId>
 *   - JSON API host: https://api-xcx.qunsou.co (alt: api-xcx-qunsou.weiyoubot.cn),
 *     NOT m.xiaoqiandao.com (that returns SPA HTML).
 *   - Envelope: { sta: 0, data, msg }; success msg often "ok".
 *   - Login: GET /xcx/checkin_web/v1/qrcode?token=<rand> -> data.qrcode;
 *            poll GET /xcx/checkin_web/v1/check_status?token=<rand> -> data.access_token.
 *   - List:  GET /xcx/checkin/v3/list?type=5&page=1&count=10&access_token&tag=0
 *   - Detail: GET /xcx/checkin/v5/detail[_noauth]?cid=&access_token&random_num=
 *   - Submit: POST /xcx/checkin/v3/doit
 *       simple:   { cid, access_token, latitude:0, longitude:0 }
 *       location: { cid, access_token, latitude, longitude, fill_params:[{key:6,val,lat,lon}] }
 *     detail.has_checked = 1 means already signed; detail.locations[].range = geofence metres.
 */
import { fetchJson } from './http.js';
import { launchChrome, connectFirstPage, captureNetwork } from './cdp.js';
import { sleep } from './util.js';

export const WEB_BASE = 'https://m.xiaoqiandao.com';
export const API_HOSTS = ['https://api-xcx.qunsou.co', 'https://api-xcx-qunsou.weiyoubot.cn'];
export const API_BASE = API_HOSTS[0];
const H = { 'Content-Type': 'application/json', Accept: 'application/json', Origin: WEB_BASE, Referer: WEB_BASE + '/' };
export const EP = {
  loginQr: '/xcx/checkin_web/v1/qrcode',
  loginCheck: '/xcx/checkin_web/v1/check_status',
  list: '/xcx/checkin/v3/list',
  detail: '/xcx/checkin/v5/detail',
  detailNoauth: '/xcx/checkin/v5/detail_noauth',
  submit: '/xcx/checkin/v3/doit',
  join: '/xcx/checkin/v5/join',
};

/** Try each API host; skip a host that answers with SPA HTML instead of JSON. */
async function api(method, path, { query, body, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (const host of API_HOSTS) {
    const url = new URL(host + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    try {
      const r = await fetchJson(url.toString(), { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });
      if (r.json === null && /<!doctype|<html/i.test(String(r.text))) {
        lastErr = new Error('接口返回 HTML（可能不是 API 主机）');
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('API 请求失败');
}

function apiErr(json, text) {
  if (!json) throw new Error('接口返回非 JSON：' + String(text || '').slice(0, 160));
  const e = new Error(json.msg || json.message || `接口错误 sta=${json.sta}`);
  e.apiCode = json.sta;
  return e;
}

/** Extract the check-in id from a share link / raw cid. cid is a 24-hex ObjectId. */
export function parseCid(input) {
  if (!input) throw new Error('缺少 cid 或分享链接');
  const s = String(input).trim();
  if (/^[0-9a-f]{24}$/i.test(s)) return s.toLowerCase();
  if (/^\d{5,}$/.test(s)) return s;
  try {
    const u = new URL(s, WEB_BASE);
    for (const k of ['cid', 'checkin_id', 'id']) {
      const v = u.searchParams.get(k);
      if (v) return v;
    }
    const mh = (u.hash || '').match(/([0-9a-f]{24})/i);
    if (mh) return mh[1].toLowerCase();
    const mp = u.pathname.match(/([0-9a-f]{24})/i);
    if (mp) return mp[1].toLowerCase();
  } catch {
    /* fall through */
  }
  const any = s.match(/([0-9a-f]{24})/i) || s.match(/([0-9A-Za-z_-]{16,})/);
  if (any) return any[1];
  throw new Error('无法从链接解析 cid（应形如 https://m.xiaoqiandao.com/detail?cid=<24位>）');
}

export function createQrToken() {
  return String(Date.now() + Math.ceil(1e15 * Math.random()));
}

export async function loginQr() {
  const qrToken = createQrToken();
  const r = await api('GET', EP.loginQr, { query: { token: qrToken }, timeoutMs: 15000 });
  const j = r.json;
  if (!j || j.sta !== 0 || !j.data || !j.data.qrcode) throw apiErr(j, r.text);
  return { qrToken, qrcode: j.data.qrcode };
}

export async function loginPoll(qrToken, { timeoutMs = 150000, intervalMs = 2500 } = {}) {
  if (!qrToken) throw new Error('缺少 qrToken，请先 login-qr');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(intervalMs);
    const r = await api('GET', EP.loginCheck, { query: { token: qrToken }, timeoutMs: 15000 });
    const j = r.json || {};
    if (j.sta === 0 && j.data && j.data.access_token) return { token: j.data.access_token, userInfo: j.data };
    if (j.sta === -1) throw new Error(j.msg || '二维码已失效，请重新获取');
  }
  throw new Error('等待扫码超时');
}

export async function list({ token, type = 5, page = 1, count = 20, keyword = '' } = {}) {
  const r = await api('GET', EP.list, {
    query: { type, page, count, access_token: token, tag: 0, keyword: keyword || '' },
    timeoutMs: 20000,
  });
  const j = r.json;
  if (!j || j.sta !== 0) throw apiErr(j, r.text);
  return (j.data || []).map((x) => ({ cid: x.cid, title: x.title, status: x.status, hasCheck: x.has_check, isEnd: x.is_end, start: x.start_date, end: x.end_date, owner: x.owner }));
}

export async function detail(cid, { token } = {}) {
  const useAuth = !!token;
  const r = await api('GET', useAuth ? EP.detail : EP.detailNoauth, {
    query: { source: 'h5', cid, random: String(Math.random()), random_num: String(Math.random()), access_token: token },
    timeoutMs: 20000,
  });
  const j = r.json;
  if (!j || j.sta !== 0 || !j.data) throw apiErr(j, r.text);
  return j.data;
}

export function summarizeDetail(cid, d) {
  const locs = Array.isArray(d && d.locations) ? d.locations : [];
  const fill = Array.isArray(d && d.fill_options) ? d.fill_options : [];
  const geoField = fill.find((f) => f.field_key === 6 && (f.status === 1 || f.status === undefined));
  const regInfo = Array.isArray(d && d.reg_info) ? d.reg_info : [];
  const limit = Number(d && d.limit) || 1;
  const hasCheckedCount = Number(d && d.has_checked) || 0;
  const timeStatus = Number(d && d.time_status);
  const status = Number(d && d.status);
  const template = d && d.template;
  return {
    cid,
    title: d && (d.title || d.origin_title || d.alias),
    template,
    templateName: template === 2 ? '班级/作业签到' : template === 1 ? '会议签到' : d && d.pic_text ? '图片文字打卡' : '普通/位置签到',
    geoFence: locs.length > 0,
    geoFillField: !!geoField,
    locations: locs,
    range: d && d.range,
    needLocation: locs.length > 0 || !!geoField,
    hasCheckedCount,
    limit,
    signedNow: (timeStatus === 0 && hasCheckedCount > 0) || hasCheckedCount >= Math.max(1, limit),
    ended: status === 2,
    inWindow: timeStatus === 1,
    status,
    timeStatus,
    regRequired: !(d && d.has_joined) && regInfo.length > 0,
    reqToken: !!(d && d.req_token),
    scanRequired: !!(d && d.scan_required),
    wifiRequired: Array.isArray(d && d.wifis) && d.wifis.length > 0,
    isClassWork: template === 2,
    startDate: d && d.start_date,
    endDate: d && d.end_date,
    fillFields: fill.map((f) => ({ key: f.field_key, name: f.field_name, type: f.field_type, require: f.require, status: f.status })),
    regFields: regInfo.map((f) => ({ key: f.field_key, name: f.field_name, require: f.require })),
    raw: d,
  };
}

/** Join a check-in that requires registration/口令 before submitting. */
export async function join(cid, { token, regParams, referer } = {}) {
  if (!token) throw new Error('需要登录态（access_token）');
  const body = { cid, access_token: token, referer: referer || '', refer_type: 29 };
  if (Array.isArray(regParams) && regParams.length) body.reg_params = regParams;
  const r = await api('POST', EP.join, { body, timeoutMs: 20000 });
  const j = r.json || {};
  if (j.sta === 0) return { ok: true, data: j.data, raw: j };
  throw apiErr(j, r.text);
}

/**
 * Submit a check-in.
 *  - geofence (locations[]) with no geo form field can't be submitted from H5 → NEED_MINIPROGRAM
 *  - geo form field (fill_options key 6) → fill_params:[{key:6,val,lat,lon}]
 *  - otherwise simple { cid, access_token }
 * @param detailData pass the detail object so the right shape is chosen.
 */
export async function submit(cid, { token, lat, lng, address, detailData, joinFirst } = {}) {
  if (!token) throw new Error('需要登录态（access_token）');
  const d = detailData || null;
  const fill = d && Array.isArray(d.fill_options) ? d.fill_options : [];
  const geoField = fill.find((f) => f.field_key === 6 && (f.status === 1 || f.status === undefined));
  const locs = d && Array.isArray(d.locations) ? d.locations : [];
  const latN = Number(lat);
  const lngN = Number(lng);
  const hasCoords = Number.isFinite(latN) && Number.isFinite(lngN);

  if (locs.length > 0 && !geoField && !hasCoords) {
    const e = new Error('该签到使用电子围栏定位，H5 端无法提交，需用小程序（或抓到小程序请求后用 api 回放）');
    e.code = 'NEED_MINIPROGRAM';
    throw e;
  }
  if (geoField && !hasCoords) {
    const e = new Error('该签到需要填写地理位置，请提供 lat/lng（可先 geo geocode 一个地点）');
    e.code = 'NEED_LOCATION';
    throw e;
  }
  if (joinFirst) await join(cid, { token });

  const base = { cid, access_token: token };
  const body = geoField || hasCoords ? { ...base, fill_params: [{ key: 6, val: address || '签到地点', lat: latN, lon: lngN }] } : base;
  const r = await api('POST', EP.submit, { body, timeoutMs: 20000 });
  const j = r.json || {};
  const ok = j.sta === 0 && (j.msg === 'ok' || j.msg === undefined || j.data !== undefined);
  if (ok) return { ok: true, strategy: geoField || hasCoords ? 'fill_params' : 'simple', data: j.data, raw: j };
  throw apiErr(j, r.text);
}

/** Capture the /xcx/* requests the H5 app makes for a share link (to reverse variants). */
export async function capture(url, { waitMs = 8000 } = {}) {
  const chrome = await launchChrome({ headless: true });
  let cdp;
  try {
    const c = await connectFirstPage(chrome);
    cdp = c.cdp;
    const recs = await captureNetwork(cdp, { url, waitMs });
    return { all: recs.length, endpoints: recs.filter((r) => /\/xcx\//.test(r.url)) };
  } finally {
    try {
      cdp && cdp.close();
    } catch {
      /* ignore */
    }
    try {
      chrome.cleanup();
    } catch {
      /* ignore */
    }
  }
}
