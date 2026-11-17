/**
 * 课堂派 (ketangpai) adapter — reverse-engineered from the web client's API.
 *
 * Key domain facts:
 *   - API base https://openapiv5.ketangpai.com, POST JSON, header `token: <token>`.
 *   - Response {status:1,data} on success; code 20003 = token expired.
 *   - Attendance types: 0 传统 / 1 数字 / 2 GPS / 3 扫码 / 4 签入签出.
 *   - `state` alone is unreliable: require signTime>0 and state in {0,2,7}.
 *   - Check-in/out (type 4) is TWO submissions on the same attenceid; verify checkout
 *     by resultCheckoutTime, not signTime.
 *   - GPS attendances may have an electronic fence; zero coordinates can be accepted
 *     server-side but rejected in the teacher's stats, so prefer real coordinates.
 */
import { fetchJson } from './http.js';
import { wgs84ToGcj02 } from './geo.js';
import { sleep } from './util.js';

export const API_BASE = 'https://openapiv5.ketangpai.com';

function terr(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

async function api(token, apiPath, body = {}, { retries = 3, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let r;
    try {
      r = await fetchJson(API_BASE + apiPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          token,
          Origin: 'https://w.ketangpai.com',
          Referer: 'https://w.ketangpai.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
        },
        body: JSON.stringify({ ...body, reqtimestamp: Date.now() }),
        timeoutMs,
      });
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw terr('NETWORK', '网络请求失败：' + (e.message || e));
    }
    const json = r.json;
    if (!json) throw terr('BAD_RESPONSE', `接口返回非 JSON（HTTP ${r.status}）`);
    if (json.status === 1) return json.data;
    if (json.code === 20003) throw terr('NOT_LOGGED_IN', json.message || '课堂派登录已过期');
    throw terr('API_ERROR', json.message || '接口错误', { apiCode: json.code });
  }
  throw lastErr || terr('NETWORK', '请求失败');
}

// ---------------------------------------------------------------- endpoints

export async function fetchCourses(token) {
  const d = await api(token, '/courseApi/simpleLists', {});
  return (d && d.lists) || [];
}

export async function fetchPending(token, courseId) {
  try {
    const d = await api(token, '/AttenceApi/getNotFinishAttenceStudent', { courseid: courseId });
    return d && Array.isArray(d.lists) ? d.lists : [];
  } catch (e) {
    if (e.code === 'NOT_LOGGED_IN') throw e;
    return [];
  }
}

export async function fetchRecent(token, courseId, size = 10) {
  try {
    const d = await api(token, '/SummaryApi/attence', { courseid: courseId, page: 1, size });
    if (d && d.data && Array.isArray(d.data.data)) return d.data.data;
    if (d && Array.isArray(d.data)) return d.data;
    return [];
  } catch (e) {
    if (e.code === 'NOT_LOGGED_IN') throw e;
    return [];
  }
}

export async function fetchCheckInResult(token, attenceId) {
  try {
    return await api(token, '/AttenceApi/getCheckInResult', { attenceid: attenceId });
  } catch (e) {
    if (e.code === 'NOT_LOGGED_IN') throw e;
    return null;
  }
}

async function submitPayload(token, payload) {
  return api(token, '/AttenceApi/checkin', payload);
}

// ---------------------------------------------------------------- domain logic

export const ATTEND_TYPE = { 0: '传统考勤', 1: '数字考勤', 2: 'GPS考勤', 3: '扫码考勤', 4: '签入签出' };
export const STATE_LABEL = { 0: '出勤', 1: '缺勤', 2: '迟到', 3: '请假', 4: '事假', 5: '病假', 6: '公假', 7: '早退', 100: '待签到', '-2': '已结束' };
const SIGNED_STATES = new Set(['0', '2', '7']);
const typeName = (t) => ATTEND_TYPE[String(t)] || String(t);

export function evaluateSignRecord(rec) {
  if (!rec) return { signed: false, reason: 'no-record' };
  const state = String(rec.state);
  const signTime = Number(rec.signTime || 0);
  if (!SIGNED_STATES.has(state)) return { signed: false, reason: `state=${state}(${STATE_LABEL[state] || '?'})` };
  if (signTime <= 0) return { signed: false, reason: 'state 像签上了但 signTime=0，判定未签到' };
  return { signed: true, reason: `state=${state}(${STATE_LABEL[state]}) signTime=${signTime}` };
}

export function describeAttence(r, opts = {}) {
  const type = String(r.type);
  const state = String(r.state);
  const signTime = Number(r.signTime || 0);
  if (type === '4') {
    const inT = Number(r.resultCheckinTime || 0);
    const outT = Number(r.resultCheckoutTime || 0);
    if (outT > 0) return { label: '已签入·已签出', phase: 'done' };
    if (inT > 0) return { label: '已签入·待签出', phase: 'out' };
    if (state === '100') return { label: '待签入', phase: 'in' };
    if (state === '-2') return { label: '已结束', phase: 'ended' };
    return { label: STATE_LABEL[state] || `状态${state}`, phase: 'other' };
  }
  if (state === '100') return { label: '待签到', phase: 'in' };
  if (SIGNED_STATES.has(state)) {
    if (signTime <= 0) return { label: '未确认（state 异常）', phase: 'other' };
    if (opts.gpsSuspicious) return { label: `${STATE_LABEL[state] || '已签'}（坐标异常）`, phase: 'suspect' };
    return { label: STATE_LABEL[state] || '已签到', phase: 'done' };
  }
  if (state === '1') return { label: '缺勤', phase: 'miss' };
  if (state === '3') return { label: '请假', phase: 'leave' };
  if (state === '-2') return { label: '已结束', phase: 'ended' };
  return { label: STATE_LABEL[state] || `状态${state}`, phase: 'other' };
}

export function pickCheckouts(rows, now = Math.floor(Date.now() / 1000)) {
  const out = [];
  for (const r of rows || []) {
    if (String(r.type) !== '4') continue;
    if (!Number(r.checkouttime || 0)) continue;
    if (Number(r.resultCheckinTime || 0) <= 0) continue;
    if (Number(r.resultCheckoutTime || 0) > 0) continue;
    const overtime = Number(r.overtime || 0);
    if (overtime && now > overtime) continue;
    out.push(r);
  }
  return out;
}

function coordsForSubmit(coords) {
  if (!coords) return { latitude: '', longitude: '' };
  const lat = Number(coords.latitude ?? coords.lat);
  const lng = Number(coords.longitude ?? coords.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return { latitude: '', longitude: '' };
  const out = coords.coordsAreWgs84 ? wgs84ToGcj02(lat, lng) : { latitude: lat, longitude: lng };
  return { latitude: String(out.latitude), longitude: String(out.longitude) };
}

function buildSubmitPlans(item, code, coords, { requireGpsCoords = false } = {}) {
  const type = String(item.type);
  const base = { id: item.id, code: code || '', accuracy: '', appid: '', clienttype: '1' };
  const hasCoords = !!(coords && coords.latitude && coords.longitude);
  if (type === '2' && !hasCoords && requireGpsCoords) return { plans: [], blocked: 'gps-no-coords' };
  const lat = hasCoords ? coords.latitude : '';
  const lng = hasCoords ? coords.longitude : '';
  const zero = { latitude: '0.00000000', longitude: '0.00000000' };
  const combos = [
    { label: hasCoords ? 'normal' : 'normal(no-coords)', unusual: '', lat, lng },
    { label: 'exception-mark', unusual: '1', lat, lng },
    { label: 'zero-coords', unusual: '', lat: zero.latitude, lng: zero.longitude },
  ];
  const seen = new Set();
  const plans = [];
  for (const c of combos) {
    const payload = { ...base, unusual: c.unusual, latitude: c.lat, longitude: c.lng };
    const sig = JSON.stringify([payload.unusual, payload.latitude, payload.longitude]);
    if (seen.has(sig)) continue;
    seen.add(sig);
    plans.push({ label: c.label, payload });
  }
  return { plans, blocked: null };
}

async function findRecord(token, courseId, attenceId) {
  const rows = await fetchRecent(token, courseId, 10);
  return rows.find((x) => String(x.id) === String(attenceId)) || null;
}

async function verifySigned(token, courseId, attenceId, type) {
  let last = null;
  for (let v = 0; v < 4; v++) {
    if (v) await sleep(700);
    const rec = await findRecord(token, courseId, attenceId);
    if (!rec) continue;
    last = rec;
    const ev = evaluateSignRecord(rec);
    if (!ev.signed) continue;
    if (String(type) === '2') {
      const cr = await fetchCheckInResult(token, attenceId);
      const lat = Number(cr?.latitude ?? 0);
      const lng = Number(cr?.longitude ?? 0);
      const zeroCoords = lat === 0 && lng === 0;
      if (zeroCoords) return { ok: true, suspicious: true, reason: `${ev.reason}，但坐标为零（老师端可能不认）` };
    }
    return { ok: true, suspicious: false, reason: ev.reason };
  }
  return { ok: false, reason: last ? `复核未通过（state=${last.state}, signTime=${last.signTime || 0}）` : '复核未查到该考勤记录' };
}

export async function submitCheckin(token, course, item, { code = '', coords, requireGpsCoords = false } = {}) {
  const before = await findRecord(token, course.id, item.id);
  const pre = evaluateSignRecord(before);
  if (pre.signed) return { ok: true, already: true, verify: pre.reason };

  const resolvedCoords = coordsForSubmit(coords);
  const { plans, blocked } = buildSubmitPlans(item, code, resolvedCoords, { requireGpsCoords });
  if (blocked) return { ok: false, blocked, error: 'GPS 考勤需要教室坐标，当前未提供' };

  let lastErr = '';
  for (const plan of plans) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await submitPayload(token, plan.payload);
        const verdict = await verifySigned(token, course.id, item.id, item.type);
        if (verdict.ok) return { ok: true, suspicious: verdict.suspicious, verify: verdict.reason, strategy: plan.label };
        lastErr = verdict.reason;
        break;
      } catch (e) {
        if (e.code === 'NOT_LOGGED_IN') throw e;
        const msg = String(e.message || '');
        if (/已经签到|重复签到|已签到/.test(msg)) return { ok: true, already: true, verify: '接口提示已签到' };
        if (/已经结束|已结束/.test(msg)) return { ok: true, ended: true, verify: '考勤已结束' };
        if (/签到码|验证码|口令/.test(msg)) return { ok: false, fatal: true, error: msg };
        lastErr = msg || '未知错误';
        await sleep(400 + attempt * 500);
      }
    }
  }
  return { ok: false, error: lastErr };
}

export async function submitCheckout(token, course, rec, { coords, requireGpsCoords = false } = {}) {
  const resolvedCoords = coordsForSubmit(coords);
  const { plans, blocked } = buildSubmitPlans(rec, '', resolvedCoords, { requireGpsCoords });
  if (blocked) return { ok: false, blocked, error: '签出需要坐标，当前未提供' };
  let lastErr = '';
  for (const plan of plans) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await submitPayload(token, plan.payload);
        let last = null;
        for (let v = 0; v < 4; v++) {
          if (v) await sleep(700);
          last = await findRecord(token, course.id, rec.id);
          if (last && Number(last.resultCheckoutTime || 0) > 0) {
            return { ok: true, verify: `签出时间 ${new Date(Number(last.resultCheckoutTime) * 1000).toLocaleString('zh-CN', { hour12: false })}`, strategy: plan.label };
          }
        }
        lastErr = `接口返回成功，但复核未签出（resultCheckoutTime=${last ? last.resultCheckoutTime : '无记录'}）`;
        break;
      } catch (e) {
        if (e.code === 'NOT_LOGGED_IN') throw e;
        const msg = String(e.message || '');
        if (/未到签出时间/.test(msg)) return { ok: false, early: true, error: msg };
        if (/已经签出|重复签出|已签出/.test(msg)) return { ok: true, already: true, verify: '接口提示已签出' };
        lastErr = msg || '未知错误';
        await sleep(400 + attempt * 500);
      }
    }
  }
  return { ok: false, error: lastErr };
}

// ---------------------------------------------------------------- high level

export async function doctor(token) {
  const checks = [];
  try {
    const courses = await fetchCourses(token);
    checks.push({ name: 'token', ok: true, detail: `已登录，${courses.length} 门课程` });
  } catch (e) {
    checks.push({ name: 'token', ok: false, detail: e.message });
  }
  return { checks };
}

export async function listCourses(token) {
  const courses = await fetchCourses(token);
  return (courses || []).map((c) => ({ id: c.id, name: c.name, courseName: c.courseName || c.name }));
}

/** Aggregate all courses' server-computed pending attendance list. */
export async function scanPending(token) {
  const courses = await fetchCourses(token);
  const out = [];
  for (const c of courses) {
    const pending = await fetchPending(token, c.id);
    for (const p of pending) out.push({ courseId: c.id, courseName: c.name, ...p });
  }
  return out;
}

export async function recentAttendance(token, courseId, size = 10) {
  const rows = await fetchRecent(token, courseId, size);
  return rows.map((r) => ({ ...r, typeName: typeName(r.type), status: describeAttence(r) }));
}

export async function signAll(token, { courseId, attenceId, code = '', coords, requireGpsCoords = false } = {}) {
  const results = [];
  if (courseId && attenceId) {
    const course = { id: courseId, name: courseId };
    const rows = await fetchRecent(token, courseId, 10);
    const item = rows.find((x) => String(x.id) === String(attenceId)) || { id: attenceId, type: '0' };
    const r = await submitCheckin(token, course, item, { code, coords, requireGpsCoords });
    results.push({ courseId, attenceId, ...r });
    return results;
  }
  const pending = await scanPending(token);
  for (const p of pending) {
    if (String(p.type) === '3') {
      results.push({ courseId: p.courseId, courseName: p.courseName, attenceId: p.id, ok: false, needScan: true, error: '扫码考勤需本人微信扫码' });
      continue;
    }
    const course = { id: p.courseId, name: p.courseName };
    const r = await submitCheckin(token, course, p, { code, coords, requireGpsCoords });
    results.push({ courseId: p.courseId, courseName: p.courseName, attenceId: p.id, type: typeName(p.type), title: p.title, ...r });
  }
  return results;
}

export async function checkoutAll(token, { courseId, attenceId, coords, requireGpsCoords = false } = {}) {
  const results = [];
  const courses = courseId ? [{ id: courseId, name: courseId }] : await fetchCourses(token);
  for (const c of courses) {
    const rows = await fetchRecent(token, c.id, 10);
    const targets = attenceId ? rows.filter((r) => String(r.id) === String(attenceId)) : pickCheckouts(rows);
    for (const rec of targets) {
      const r = await submitCheckout(token, c, rec, { coords, requireGpsCoords });
      results.push({ courseId: c.id, courseName: c.name, attenceId: rec.id, ...r });
    }
  }
  return results;
}
