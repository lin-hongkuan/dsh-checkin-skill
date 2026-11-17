/**
 * WPS 表单打卡 adapter — reverse-engineered from the form API.
 *
 * Flow: read the check-in fence from the form API, compute the polygon centroid,
 * convert GCJ-02 -> WGS84, inject it as the browser's geolocation (the page treats
 * navigator.geolocation as WGS84 then converts back), fill name/id, submit, verify.
 * Login state is a WPS cookie jar; visit account.wps.cn to let the kso session
 * refresh wps_sid, then persist the updated jar.
 */
import { sleep, UA_DESKTOP, UA_MOBILE } from './util.js';
import { gcj02ToWgs84, polygonCentroid, extractCoordsFromText } from './geo.js';
import { launchChrome, connectFirstPage, setCookies, getCookies, setGeolocation, addGeoStub, waitFor, clickSelector, clickText, typeInto, screenshot } from './cdp.js';

const SEL = {
  name: '#inputclockinName',
  studentId: '#inputclockinStudentId',
  locationBox: '.src-components-clockin-questions-q-location-write-location-index__container',
  locationBtn: '.src-components-clockin-questions-q-location-write-location-index__buttonInner',
  locationBtn2: '.src-components-clockin-questions-q-location-write-location-index__defaultButton',
  submitCircle: '.src-pages-clock-components-common-clock-button-circle-index__container',
};

const SUBMITTED_RE = /无法继续打卡/;
const NOT_STARTED_RE = /打卡未开始|不在打卡(时间|时段)|打卡已结束|收集已结束|尚未开始/;
const NEED_LOGIN_RE = /需要登录才能打卡/;

export function shareIdFromUrl(url) {
  const text = String(url || '');
  const m = text.match(/\/ksform\/(?:cw\/)?w\/([A-Za-z0-9_-]+)/) || text.match(/[?&](?:sid|shareId)=([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

async function fetchCheckinRanges(shareId) {
  const res = await fetch('https://f-api.wps.cn/ksform/api/v3/campaign/' + encodeURIComponent(shareId) + '/ranges', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('围栏接口 HTTP ' + res.status);
  const json = await res.json();
  if (json.code !== 0) throw new Error('围栏接口 code=' + json.code);
  return (json.data && json.data.items) || [];
}

/** Resolve the check-in fence centre for a WPS form; returns injectable WGS84 coords. */
export async function locate(formUrl, { rangeName = '', fallbackLat, fallbackLng } = {}) {
  const shareId = shareIdFromUrl(formUrl);
  if (!shareId) {
    if (fallbackLat != null && fallbackLng != null) return { source: 'fallback', injectWgs84: { latitude: Number(fallbackLat), longitude: Number(fallbackLng) } };
    throw new Error('无法从表单链接解析 shareId，且未提供兜底坐标');
  }
  let items;
  try {
    items = await fetchCheckinRanges(shareId);
  } catch (e) {
    if (fallbackLat != null && fallbackLng != null) return { source: 'fallback', warning: e.message, injectWgs84: { latitude: Number(fallbackLat), longitude: Number(fallbackLng) } };
    throw e;
  }
  const usable = items.filter((it) => it && it.config && Array.isArray(it.config.coordList) && it.config.coordList.length >= 3);
  if (!usable.length) {
    if (fallbackLat != null && fallbackLng != null) return { source: 'fallback', warning: '表单未配置多边形围栏', injectWgs84: { latitude: Number(fallbackLat), longitude: Number(fallbackLng) } };
    throw new Error('表单未配置多边形围栏，且未提供兜底坐标');
  }
  let pick = usable[0];
  if (rangeName) {
    const hit = usable.find((it) => String(it.rangeName || '').includes(rangeName));
    if (hit) pick = hit;
  }
  const pts = pick.config.coordList.map((q) => [Number(q[0]), Number(q[1])]).filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
  const center = polygonCentroid(pts);
  const isGcj = String(pick.config.coordType || 'gcj02').toLowerCase() !== 'wgs84';
  const wgs = isGcj ? gcj02ToWgs84(center.latitude, center.longitude) : center;
  return {
    source: 'fence',
    range: pick.rangeName || pick.rangeID,
    centerGcj02: center,
    injectWgs84: { latitude: Number(wgs.latitude.toFixed(6)), longitude: Number(wgs.longitude.toFixed(6)) },
    fenceCount: usable.length,
  };
}

/** Merge a pasted Cookie header into an existing [{name,value,...}] jar. */
export function importCookieHeader(existing, header) {
  const jar = Array.isArray(existing) ? existing.slice() : [];
  const pairs = String(header || '').split(';').map((s) => s.trim()).filter(Boolean);
  let updated = 0;
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const name = p.slice(0, i).trim();
    const value = p.slice(i + 1).trim();
    if (!name) continue;
    const httpOnly = ['wps_sid', 'kso_sid', '_ku', '_ks'].includes(name);
    const found = jar.find((c) => c.name === name && c.domain === '.wps.cn');
    if (found) {
      found.value = value;
      found.httpOnly = httpOnly;
      updated++;
    } else {
      jar.push({ name, value, domain: '.wps.cn', path: '/', expires: -1, httpOnly, secure: true, sameSite: 'None' });
      updated++;
    }
  }
  return { jar, updated };
}

export function hasRefreshCredential(jar) {
  return (jar || []).some((c) => (c.name === 'kso_sid' || c.name === '_ku') && c.value);
}

async function applyJar(cdp, cookies) {
  await cdp.send('Network.enable');
  await cdp.send('Network.clearBrowserCookies');
  await setCookies(cdp, cookies);
}

const AUTH_CHECK_JS = `fetch('/p/auth/check',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:'{}'}).then(r=>r.text()).then(t=>t.slice(0,800)).catch(e=>'ERR:'+e.message)`;
const GRANT_TOKEN_JS = `fetch('/passport/secure/api/grant_token',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({grant_type:'refresh_token'})}).then(r=>r.text()).then(t=>t.slice(0,800)).catch(e=>'ERR:'+e.message)`;

async function readAccountUser(cdp) {
  const raw = await cdp.eval(AUTH_CHECK_JS);
  try {
    const j = JSON.parse(raw);
    if (j && j.result === 'ok' && j.userid) return { ok: true, user: j };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

async function ensureSession(cdp, { jar, ua, log }) {
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (ua) await cdp.send('Emulation.setUserAgentOverride', { userAgent: ua, platform: 'Win32', acceptLanguage: 'zh-CN,zh;q=0.9' });
  await applyJar(cdp, jar);
  const before = JSON.stringify(jar.map((c) => [c.name, c.value]));

  await cdp.send('Page.navigate', { url: 'https://account.wps.cn/' });
  await sleep(7000);
  let user = await readAccountUser(cdp);
  let renewed = false;
  if (!user.ok) {
    log && log('会话校验未通过，尝试 grant_token 刷新…');
    await cdp.eval(GRANT_TOKEN_JS);
    await sleep(2500);
    user = await readAccountUser(cdp);
    renewed = user.ok;
  }
  if (user.ok) {
    await cdp.send('Page.navigate', { url: 'https://f.wps.cn/' });
    await sleep(4000);
    const u2 = await readAccountUser(cdp);
    if (u2.ok) user = u2;
  }
  const jarAfter = await getCookies(cdp, 'wps.cn');
  const changed = JSON.stringify(jarAfter.map((c) => [c.name, c.value])) !== before;
  return { ok: user.ok, user: user.user, renewed, cookiesUpdated: changed, jar: jarAfter };
}

const readBody = async (cdp) => String(await cdp.eval('document.body.innerText'));

async function autoLocate(cdp, log) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let clicked = await clickSelector(cdp, SEL.locationBtn);
    if (!clicked) clicked = await clickSelector(cdp, SEL.locationBtn2);
    if (!clicked) clicked = await clickText(cdp, '点击自动定位');
    const ok = await waitFor(
      cdp,
      `(() => { const el = document.querySelector(${JSON.stringify(SEL.locationBox)}); const t = (el && el.innerText || '').replace(/\\s+/g,''); return t.length > 4 && !t.includes('点击自动定位'); })()`,
      25000,
    );
    if (ok) return await cdp.eval(`((document.querySelector(${JSON.stringify(SEL.locationBox)})||{}).innerText || '').replace(/\\s+/g,'')`);
    await sleep(1200);
  }
  return null;
}

async function clickSubmitAndWait(cdp, log) {
  const clicked = (await clickSelector(cdp, SEL.submitCircle)) || (await clickText(cdp, '打卡'));
  if (!clicked) throw new Error('找不到打卡按钮');
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await sleep(900);
    const t = await readBody(cdp).catch(() => '');
    const confirm = await cdp
      .eval(`(() => { const els=[...document.querySelectorAll('button,[role="button"],.adm-button')]; const el=els.find(e=>/^(确认|确定|继续打卡|仍要提交)$/.test((e.innerText||'').trim())); return el?(el.innerText||'').trim():''; })()`)
      .catch(() => '');
    if (confirm) {
      await clickText(cdp, confirm);
      await sleep(1200);
      continue;
    }
    if (/打卡成功|提交成功|签到成功|打卡完成/.test(t)) return { ok: true, reason: '页面提示打卡成功' };
    if (NOT_STARTED_RE.test(t)) return { ok: false, reason: '不在打卡时段' };
    if (/不在打卡范围|超出打卡范围|定位不在|距离太远|定位校验失败|打卡失败|提交失败/.test(t)) {
      return { ok: false, reason: t.split('\n').filter((l) => /范围|定位|失败/.test(l)).slice(0, 2).join(' | ') };
    }
    if (SUBMITTED_RE.test(t)) return { ok: true, reason: '服务端提示本轮已打卡' };
  }
  return { ok: false, reason: '等待 90 秒未收到结果' };
}

/**
 * Run a full WPS check-in. Returns a structured result and, on success/failure,
 * a screenshot path the caller can show to the user.
 */
export async function runSign(opts = {}) {
  const {
    formUrl,
    name,
    studentId,
    cookies = [],
    rangeName = '',
    lat,
    lng,
    accuracy = 30,
    dryRun = false,
    statusOnly = false,
    chromePath,
    log = () => {},
  } = opts;

  if (!formUrl) throw new Error('缺少 formUrl（打卡表单链接）');
  if (!name || !studentId) throw new Error('缺少姓名 name 或学号 studentId');
  if (!cookies.length) return { ok: false, code: 4, reason: 'NEED_COOKIE', message: '未找到 WPS 登录态，请先在浏览器登录 f.wps.cn 让 agent 读取 Cookie，或粘贴 Cookie。' };

  let coords;
  try {
    const loc = await locate(formUrl, { rangeName, fallbackLat: lat, fallbackLng: lng });
    coords = loc.injectWgs84;
    log(`定位：${coords.latitude}, ${coords.longitude}（来源 ${loc.source}${loc.range ? ' / 围栏 ' + loc.range : ''}）`);
  } catch (e) {
    return { ok: false, code: 2, reason: 'LOCATE_FAILED', message: e.message };
  }
  if (coords.latitude == null || coords.longitude == null) return { ok: false, code: 2, reason: 'NO_COORDS', message: '没有可用的定位坐标' };

  let chrome;
  try {
    chrome = await launchChrome({ headless: true, chromePath });
  } catch (e) {
    return { ok: false, code: 2, reason: 'NO_CHROME', message: e.message };
  }
  let cdp;
  try {
    const conn = await connectFirstPage(chrome);
    cdp = conn.cdp;
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await addGeoStub(cdp, { latitude: coords.latitude, longitude: coords.longitude, accuracy });
    await setGeolocation(cdp, { latitude: coords.latitude, longitude: coords.longitude, accuracy, origin: new URL(formUrl).origin }).catch(() => {});

    const sess = await ensureSession(cdp, { jar: cookies, ua: UA_DESKTOP, log });
    if (!sess.ok) {
      return { ok: false, code: 4, reason: 'NEED_COOKIE', message: 'WPS 登录态已失效，请让 agent 重新读取浏览器 Cookie。', jar: sess.jar };
    }
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: UA_MOBILE, platform: 'iPhone', acceptLanguage: 'zh-CN,zh;q=0.9' });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setGeolocationOverride', { latitude: coords.latitude, longitude: coords.longitude, accuracy });

    await cdp.send('Page.navigate', { url: formUrl });
    if (!(await waitFor(cdp, `document.querySelector(${JSON.stringify(SEL.name)})`, 60000))) {
      const shot = await screenshot(cdp).catch(() => null);
      throw new Error('表单加载失败（未找到姓名输入框）');
    }
    await sleep(1500);
    let body = await readBody(cdp);
    if (NEED_LOGIN_RE.test(body)) {
      return { ok: false, code: 4, reason: 'NEED_COOKIE', message: '页面提示需要登录才能打卡，Cookie 失效。' };
    }
    const readOnly = await cdp.eval(`(document.querySelector(${JSON.stringify(SEL.name)})||{}).readOnly === true`);
    const already = SUBMITTED_RE.test(body) || readOnly;
    if (already) {
      const shot = await screenshot(cdp).catch(() => null);
      return { ok: true, code: 0, reason: 'ALREADY', message: '本轮已打卡，无需重复提交', screenshot: shot, jar: sess.jar };
    }
    if (statusOnly) {
      return { ok: false, code: 3, reason: 'NOT_YET', message: '本轮尚未打卡', jar: sess.jar };
    }

    await typeInto(cdp, SEL.name, name);
    await typeInto(cdp, SEL.studentId, studentId);
    const addr = await autoLocate(cdp, log);
    if (dryRun) {
      const shot = await screenshot(cdp).catch(() => null);
      return { ok: true, code: 0, reason: 'DRY_RUN', message: `已填表并定位${addr ? '：' + addr : ''}，未提交`, screenshot: shot, coords, jar: sess.jar };
    }
    if (!addr) log('自动定位未返回地址，但经纬度已注入，继续尝试打卡');

    const res = await clickSubmitAndWait(cdp, log);
    if (!res.ok) {
      const shot = await screenshot(cdp).catch(() => null);
      return { ok: false, code: 1, reason: 'FAILED', message: res.reason, screenshot: shot, coords, jar: sess.jar };
    }
    await sleep(1200);
    const shot = await screenshot(cdp).catch(() => null);
    // Verify by reloading the form.
    await cdp.send('Page.navigate', { url: formUrl });
    await sleep(2500);
    const body2 = await readBody(cdp).catch(() => '');
    const verified = SUBMITTED_RE.test(body2);
    return { ok: true, code: 0, reason: 'SUCCESS', message: res.reason, verified, coords, address: addr || null, screenshot: shot, jar: sess.jar };
  } finally {
    try {
      cdp?.close();
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
