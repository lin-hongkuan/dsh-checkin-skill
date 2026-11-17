/**
 * 群报数 (qun100) adapter — ported from the local qun100-checkin CLI.
 *
 * Facts (reverse-engineered):
 *   - Business API host is https://form.qun100.com (not www / fastformapi).
 *   - Auth header is `Authorization: <token>` (no Bearer prefix); token comes from
 *     the WeChat official-account QR login.
 *   - Every call needs `Client-Form-Id`; submission is POST /v1/{fid}/form_data
 *     with `formVersion` and a `catalogs` array containing every required answer.
 */
import { fetchJson } from './http.js';
import { resolvePlace, distanceMeters } from './geo.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const API_HOST = 'https://form.qun100.com';
export const MP_APPID = 'wxa4dd314619820d4c';
export const CLIENT_VER = '3.80.0';

function terr(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

export function parseFormUrl(input) {
  if (!input) throw terr('BAD_ARGS', '缺少 url 或 formId');
  const text = String(input).trim();
  if (/^\d{10,}$/.test(text)) return text;
  let u;
  try {
    u = new URL(text);
  } catch {
    throw terr('BAD_ARGS', `无法解析表单地址: ${text}`);
  }
  const fid = u.searchParams.get('fid') || u.searchParams.get('formId');
  if (!fid) throw terr('BAD_ARGS', `链接里没有 fid/formId 参数: ${text}`);
  return fid;
}

function baseHeaders(token, formId) {
  const h = {
    'Content-Type': 'application/json',
    'Client-App-Id': MP_APPID,
    ver: CLIENT_VER,
    'Client-Env': 'h5',
    Origin: 'https://h5.qun100.com',
    Referer: 'https://h5.qun100.com/',
  };
  if (token) h.Authorization = token;
  if (formId) h['Client-Form-Id'] = String(formId);
  return h;
}

async function request(token, method, apiPath, { body, formId } = {}) {
  const url = apiPath.startsWith('http') ? apiPath : API_HOST + apiPath;
  const r = await fetchJson(url, {
    method,
    headers: baseHeaders(token, formId),
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 30000,
  });
  return r;
}

function ensureCode(json, text, fallback) {
  if (!json || json.code !== 0) {
    throw terr('SUBMIT_FAILED', `${fallback}: ${json?.message || text || '未知错误'}`, { apiCode: json?.code });
  }
  return json.data;
}

export async function userInfo(token) {
  const r = await request(token, 'GET', '/v1/userInfo');
  if (r.json?.code !== 0) throw terr('NOT_LOGGED_IN', `token 无效或已过期: ${r.json?.message || r.text}`);
  return r.json.data;
}

export async function profile(token, fid) {
  const r = await request(token, 'GET', `/v1/form/${fid}/profile`, { formId: fid });
  return ensureCode(r.json, r.text, '读取表单失败');
}

export async function catalog(token, fid) {
  const r = await request(token, 'GET', `/v1/form/${fid}/catalog`, { formId: fid });
  return ensureCode(r.json, r.text, '读取题目失败');
}

export async function myRecords(token, fid) {
  const r = await request(token, 'GET', `/v3/${fid}/form_data`, { formId: fid });
  if (r.json?.code !== 0) throw terr('SUBMIT_FAILED', `读取提交记录失败: ${r.json?.message || r.text}`);
  return r.json.data?.formDataDtoList || [];
}

export async function submit(token, fid, payload) {
  return request(token, 'POST', `/v1/${fid}/form_data`, { body: payload, formId: fid });
}

export function liveQuestions(catalogData) {
  return (catalogData?.catalogs || []).filter((c) => c.catalogType === 'QUESTION' && c.status !== -1);
}
export function questionTitle(c) {
  const list = c.formCatalogs || [];
  const title = list.find((f) => f.role === 'TITLE') || list[0];
  return (title?.content || '').replace(/\s+/g, ' ').trim();
}
export function isRequired(c) {
  return c.must === true;
}
export function specifiedLocation(c) {
  const cfg = c.config?.SPECIFIED_LOCATION;
  if (!cfg?.active) return null;
  const content = cfg.content || {};
  const loc = (content.locations || [])[0];
  return {
    optional: !!content.optionalPosition,
    address: loc?.address || content.address || '',
    title: loc?.specifiedAddress || content.specifiedAddress || '',
    latitude: loc?.latitude ?? content.latitude,
    longitude: loc?.longitude ?? content.longitude,
    scope: loc?.scope,
  };
}
export function buildLocationValue({ lat, lng, address, title, specified }) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw terr('BAD_COORDS', '经纬度非法');
  const value = {
    address: address || specified?.address || '',
    title: title || specified?.title || '',
    location: { type: 'Point', coordinates: [longitude, latitude] },
    latitude,
    longitude,
  };
  if (specified && !specified.optional) {
    value.specifiedAddress = specified.title || '';
    value.setupLongitude = specified.longitude ?? longitude;
    value.setupLatitude = specified.latitude ?? latitude;
    value.setupAddress = specified.address || '';
  }
  return value;
}

const isStudentQuestion = (t) => /学号|学籍号|student\s*id/i.test(t);
const isNameQuestion = (t) => /姓名|名字|name/i.test(t);

const TYPE_LABEL = {
  WORD: '文本', LOCATION: '定位', RADIO: '单选', CHECKBOX: '多选', IMAGE: '图片', DATE: '日期',
  TIME: '时间', NUMBER: '数字', PHONE: '手机号', ID_CARD: '身份证', SIGNATURE: '签名', TABLE: '表格',
  RATING: '评分', FILE: '文件', VIDEO: '视频', AUDIO: '音频',
};

// ---------------------------------------------------------------- login

export async function createLoginQr() {
  const r = await fetchJson(`${API_HOST}/v1/${MP_APPID}/mpQrCode`, {
    headers: {
      'Client-App-Id': MP_APPID,
      ver: CLIENT_VER,
      'Client-Env': 'h5',
      Origin: 'https://h5.qun100.com',
      Referer: 'https://h5.qun100.com/',
    },
    timeoutMs: 15000,
  });
  const json = r.json;
  if (!json || json.code !== 0) throw terr('LOGIN_FAILED', `申请二维码失败: ${json?.message || r.text}`);
  return { scene: json.data.scene, qrUrl: json.data.ticket.url, expireSeconds: json.data.ticket.expireSeconds };
}

export async function pollLoginResult(scene) {
  const r = await fetchJson(`${API_HOST}/v1/mpQrLoginResult?scene=${encodeURIComponent(scene)}`, {
    headers: {
      'Client-App-Id': MP_APPID,
      ver: CLIENT_VER,
      'Client-Env': 'h5',
      Origin: 'https://h5.qun100.com',
      Referer: 'https://h5.qun100.com/',
    },
    timeoutMs: 15000,
  });
  if (!r.json || r.json.code !== 0) throw terr('LOGIN_FAILED', `轮询登录状态失败: ${r.json?.message || r.text}`);
  return r.json.data || null;
}

/** Fetch a QR image for a URL and save it locally; returns the file path. */
export async function renderQr(qrUrl) {
  try {
    const u = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=10&data=${encodeURIComponent(qrUrl)}`;
    const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const file = path.join(os.tmpdir(), `dsh-checkin-qr-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- high level

export async function doctor(token, { amapKey } = {}) {
  const checks = [];
  let me = null;
  try {
    me = await userInfo(token);
    checks.push({ name: 'token', ok: true, detail: `${me.userInfo?.nickName || '(未设置昵称)'} / fuid=${me.fuid}` });
  } catch (e) {
    checks.push({ name: 'token', ok: false, detail: e.message });
  }
  try {
    const r = await fetchJson(`${API_HOST}/`, {
      headers: { 'Client-App-Id': MP_APPID, ver: CLIENT_VER, 'Client-Env': 'h5' },
      timeoutMs: 10000,
    });
    checks.push({ name: 'api', ok: r.status > 0, detail: `HTTP ${r.status}` });
  } catch (e) {
    checks.push({ name: 'api', ok: false, detail: e.message });
  }
  checks.push({
    name: 'geocode:amap',
    ok: !!(amapKey || process.env.AMAP_KEY),
    detail: amapKey || process.env.AMAP_KEY ? '已配置 AMAP_KEY' : '未配置（可选，配了更准）',
  });
  return { loggedIn: !!me, user: me ? { nickname: me.userInfo?.nickName || '', fuid: me.fuid } : null, checks };
}

export async function status(token, { url } = {}) {
  const me = await userInfo(token);
  const out = { loggedIn: true, nickname: me.userInfo?.nickName || '', fuid: me.fuid };
  if (url) {
    const fid = parseFormUrl(url);
    const p = await profile(token, fid);
    const records = await myRecords(token, fid);
    const active = records.filter((r) => r.status === 0);
    out.form = {
      formId: fid,
      title: p.title,
      statusText: p.status === 2 ? '进行中' : `status=${p.status}`,
      signed: active.length > 0,
      participationCount: active.length,
      records: active.map((r) => ({ fid: r.fid, no: r.no, createTime: r.createTime })),
    };
  }
  return out;
}

export async function inspect(token, { url } = {}) {
  const fid = parseFormUrl(url);
  const p = await profile(token, fid);
  const cat = await catalog(token, fid);
  const questions = liveQuestions(cat).map((q) => {
    const item = {
      cid: q.cid,
      type: q.type,
      typeText: TYPE_LABEL[q.type] || q.type,
      title: questionTitle(q),
      required: isRequired(q),
    };
    if (q.type === 'LOCATION') {
      const s = specifiedLocation(q);
      item.location = s ? { ...s, hasCoordinates: !!(s.latitude && s.longitude) } : null;
    }
    return item;
  });
  return {
    formId: p.formId,
    title: p.title,
    publisher: p.nickname,
    statusText: p.status === 2 ? '进行中' : `status=${p.status}`,
    beginTime: p.config?.actBeginTime,
    endTime: p.config?.actEndTime,
    formVersion: p.version,
    perLimit: p.config?.perLimit,
    hasParticipation: p.hasParticipation,
    questions,
  };
}

export async function sign(token, opts = {}) {
  const { url, student, name, place, lat, lng, mapUrl, answers = [], dryRun = false, force = false, amapKey, city } = opts;
  const fid = parseFormUrl(url);
  const p = await profile(token, fid);
  const cat = await catalog(token, fid);
  const questions = liveQuestions(cat);

  if (p.status !== 2 && !force) throw terr('FORM_CLOSED', `表单当前不可提交（status=${p.status}）`);

  if (!force && !dryRun) {
    const records = await myRecords(token, fid);
    const active = records.filter((r) => r.status === 0);
    if (active.length) {
      const rec = active[0];
      return {
        alreadySigned: true,
        formId: fid,
        title: p.title,
        record: { fid: rec.fid, no: rec.no, createTime: rec.createTime },
      };
    }
  }

  const locQuestion = questions.find((q) => q.type === 'LOCATION');
  const specified = locQuestion ? specifiedLocation(locQuestion) : null;

  const latArg = lat === undefined || lat === null || lat === '' ? undefined : Number(lat);
  const lngArg = lng === undefined || lng === null || lng === '' ? undefined : Number(lng);
  const placeInput = place || mapUrl || '';

  let resolved = null;
  if (latArg !== undefined && lngArg !== undefined) {
    if (!Number.isFinite(latArg) || !Number.isFinite(lngArg)) throw terr('BAD_COORDS', 'lat/lng 必须是数字');
    resolved = { source: 'manual', latitude: latArg, longitude: lngArg, title: specified?.title || '', address: specified?.address || '' };
    if (specified?.latitude) {
      const d = distanceMeters(resolved, { latitude: Number(specified.latitude), longitude: Number(specified.longitude) });
      if (d > (specified.scope || 300)) resolved.warning = `手动坐标距离指定签到点约 ${Math.round(d)} 米，可能超出打卡范围`;
    }
  } else if (locQuestion) {
    resolved = await resolvePlace(placeInput, { specified, amapKey, city });
  }

  // Feedback self-correction: if the resolved point falls outside the publisher's
  // fence, prefer the authoritative specified point so the submission is not
  // rejected as "out of range". Manual coordinates are respected but flagged.
  if (specified && specified.latitude != null && specified.longitude != null && resolved) {
    const d = distanceMeters(resolved, { latitude: Number(specified.latitude), longitude: Number(specified.longitude) });
    const scope = Number(specified.scope) || 150;
    if (d > scope && resolved.source !== 'manual') {
      resolved = {
        source: 'form-specified(clamped)',
        coordinateSystem: 'gcj02',
        latitude: Number(specified.latitude),
        longitude: Number(specified.longitude),
        title: specified.title || resolved.title,
        address: specified.address || resolved.address,
        note: `解析点距指定签到点约 ${Math.round(d)} 米，已自动校正到发布者签到点以保证在范围内`,
      };
    }
  }

  const answerMap = new Map();
  for (const pair of answers) {
    const i = String(pair).indexOf('=');
    if (i > 0) answerMap.set(String(pair).slice(0, i), String(pair).slice(i + 1));
  }

  const catalogs = [];
  const missing = [];
  for (const q of questions) {
    const title = questionTitle(q);
    if (q.type === 'LOCATION') {
      if (!resolved) {
        if (isRequired(q)) missing.push(`${title || '定位'}(LOCATION)`);
        continue;
      }
      catalogs.push({
        cid: q.cid,
        type: 'LOCATION',
        value: buildLocationValue({
          lat: resolved.latitude,
          lng: resolved.longitude,
          address: resolved.address || specified?.address,
          title: resolved.title || specified?.title,
          specified,
        }),
      });
      continue;
    }
    if (answerMap.has(String(q.cid))) {
      catalogs.push({ cid: q.cid, type: q.type, value: answerMap.get(String(q.cid)) });
      continue;
    }
    if (q.type === 'WORD' && isStudentQuestion(title) && student) {
      catalogs.push({ cid: q.cid, type: 'WORD', value: String(student) });
      continue;
    }
    if (q.type === 'WORD' && isNameQuestion(title) && name) {
      catalogs.push({ cid: q.cid, type: 'WORD', value: String(name) });
      continue;
    }
    if (isRequired(q)) missing.push(`${title || q.type}(${q.type})`);
  }

  if (missing.length) {
    throw terr('MISSING_ANSWERS', `以下必填题没有作答：${missing.join('、')}。用 student 填学号、place 填地点、answers "cid=值" 填其它题型。`, { missing });
  }

  const payload = {
    fid: '',
    subscribe: {},
    catalogs,
    showQuestions: catalogs.map((c) => c.cid),
    examUsedTime: null,
    formVersion: p.version,
  };

  if (dryRun) {
    return { dryRun: true, formId: fid, title: p.title, location: resolved, payload };
  }

  const res = await submit(token, fid, payload);
  const body = res.json || {};
  if (body.code !== 0) {
    if (body.code === 13426) throw terr('ALREADY_SIGNED', '该表单限制每人只能参与 1 次，你已经有记录（用 verify 查看）', { apiCode: body.code });
    throw terr('SUBMIT_FAILED', `提交失败（HTTP ${res.status}, code=${body.code}）：${body.message || res.text}`, { httpStatus: res.status, apiCode: body.code });
  }

  const data = {
    submitted: true,
    formId: fid,
    title: p.title,
    fid: body.data?.fid,
    no: body.data?.no ?? null,
    createTime: body.data?.createTime ?? null,
    location: resolved,
  };
  try {
    const records = await myRecords(token, fid);
    const rec = records.find((r) => r.fid === data.fid) || records.find((r) => r.status === 0);
    if (rec) {
      data.record = { fid: rec.fid, no: rec.no, status: rec.status, createTime: rec.createTime };
      data.verified = rec.status === 0;
    }
  } catch {
    /* verification is best-effort */
  }
  return data;
}

export async function verify(token, { url } = {}) {
  const fid = parseFormUrl(url);
  const p = await profile(token, fid);
  const records = await myRecords(token, fid);
  const active = records.filter((r) => r.status === 0);
  return {
    formId: fid,
    title: p.title,
    signed: active.length > 0,
    activeCount: active.length,
    records: active.map((r) => ({
      fid: r.fid,
      no: r.no,
      status: r.status,
      createTime: r.createTime,
      catalogs: (r.catalogs || []).map((c) => ({
        cid: c.cid,
        type: c.type,
        value: c.value,
        coordinates: c.type === 'LOCATION' ? c.value?.location?.coordinates || null : undefined,
      })),
    })),
  };
}

export function parseSpecified(catalogData) {
  const loc = liveQuestions(catalogData).find((q) => q.type === 'LOCATION');
  return loc ? specifiedLocation(loc) : null;
}
