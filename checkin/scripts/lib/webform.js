/**
 * Generic web-form check-in adapter.
 *
 * Many check-ins are plain web forms with no documented API. This driver opens the
 * page in Chrome, injects a virtual geolocation, auto-detects the name / student-id
 * inputs by their label or attributes, fills extras, clicks a location button and
 * the submit button, then verifies + screenshots. Selector overrides are supported
 * for stubborn forms.
 */
import { launchChrome, connectFirstPage, setGeolocation, addGeoStub, setCookies, waitFor, screenshot } from './cdp.js';
import { resolvePlace } from './geo.js';
import { sleep } from './util.js';

function js(value) {
  return JSON.stringify(value);
}

const VISIBLE = 'const vis=(e)=>e&&(e.offsetParent!==null||e.getClientRects().length>0);';

/** Page-side: fill the first visible input whose label/attrs match `pattern`. */
function fillByLabelSource(pattern, value) {
  return `(() => {
    ${VISIBLE}
    const re = new RegExp(${js(pattern)}, 'i');
    let target = null;
    const labels = [...document.querySelectorAll('label,span,div,p,td,th,li,b,strong')];
    for (const el of labels) {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 24 || !re.test(t)) continue;
      const box = el.closest('div,td,li,form,section,p') || el.parentElement;
      const inp = box && box.querySelector('input,textarea');
      if (vis(inp)) { target = inp; break; }
    }
    if (!target) {
      for (const i of document.querySelectorAll('input,textarea')) {
        const s = [i.name, i.id, i.placeholder, i.getAttribute('aria-label')].filter(Boolean).join(' ');
        if (re.test(s) && vis(i)) { target = i; break; }
      }
    }
    if (!target) return false;
    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(target, ${js(String(value))});
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    target.focus();
    return true;
  })()`;
}

/** Page-side: click the first visible clickable whose text matches `pattern`. */
function clickByTextSource(pattern) {
  return `(() => {
    ${VISIBLE}
    const re = new RegExp(${js(pattern)});
    const els = [...document.querySelectorAll('button,a,[role="button"],div,span,label')];
    const hit = els.find((e) => { const t = (e.innerText || '').trim(); return t && t.length <= 20 && re.test(t) && vis(e); });
    if (!hit) return false;
    hit.click();
    return true;
  })()`;
}

async function fillField(cdp, pattern, value) {
  return cdp.eval(fillByLabelSource(pattern, value)).catch(() => false);
}

async function clickText(cdp, pattern) {
  return cdp.eval(clickByTextSource(pattern)).catch(() => false);
}

function hit(text, keywords) {
  return (keywords || []).some((k) => k && String(text).includes(k));
}

/**
 * @returns {{ok:boolean, code:string, message:string, screenshot?:string, address?:string, coords?:object, verified?:boolean}}
 */
export async function runWebSign(opts = {}) {
  const {
    url,
    name = '',
    studentId = '',
    place = '',
    lat,
    lng,
    accuracy = 30,
    extras = {},
    namePattern = '姓名|名字|^name$',
    studentPattern = '学号|学籍号|工号|student',
    submitPattern = '提交|签到|打卡|确认提交|报名|完成',
    locatePattern = '定位|获取位置|自动定位|获取定位',
    successKeywords = ['成功', '已完成', '提交成功', '签到成功', '打卡成功', '报名成功'],
    alreadyKeywords = ['已签到', '无法继续', '已提交', '重复提交', '已完成'],
    cookies = [],
    dryRun = false,
    headless = true,
    waitMs = 2000,
    chromePath,
    log = () => {},
  } = opts;

  if (!url) throw new Error('缺少 url');

  let coords = null;
  if (lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
    coords = { latitude: Number(lat), longitude: Number(lng), source: 'manual' };
  } else if (place) {
    coords = await resolvePlace(place, {});
  }

  let chrome;
  try {
    chrome = await launchChrome({ headless, chromePath });
  } catch (e) {
    return { ok: false, code: 'NO_CHROME', message: e.message };
  }
  let cdp;
  try {
    const conn = await connectFirstPage(chrome);
    cdp = conn.cdp;
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    if (cookies.length) await setCookies(cdp, cookies);
    if (coords) {
      await addGeoStub(cdp, { latitude: coords.latitude, longitude: coords.longitude, accuracy }).catch(() => {});
      await setGeolocation(cdp, { latitude: coords.latitude, longitude: coords.longitude, accuracy, origin: new URL(url).origin }).catch(() => {});
    }

    await cdp.send('Page.navigate', { url });
    await waitFor(cdp, 'document.body && document.body.innerText.length > 0', 60000);
    await sleep(waitMs);

    if (name) await fillField(cdp, namePattern, name);
    if (studentId) await fillField(cdp, studentPattern, studentId);
    for (const [k, v] of Object.entries(extras || {})) {
      // extras key is a label pattern unless it looks like a CSS selector.
      if (/^[#.\[]/.test(k)) {
        await cdp.eval(fillByLabelSource(k.replace(/^[#.]/, ''), v)).catch(() => {});
      } else {
        await fillField(cdp, k, v);
      }
    }
    // Try a location button (some forms require an explicit click to capture GPS).
    let address = null;
    if (coords) {
      const clicked = await clickText(cdp, locatePattern);
      if (clicked) {
        await sleep(2500);
        address = await cdp.eval(`(() => { const t = document.body.innerText || ''; const m = t.match(/(?:当前位置|定位|位置)[:：\\s]*([^\\n]{2,40})/); return m ? m[1].trim() : null; })()`).catch(() => null);
      }
    }

    const shotBefore = await screenshot(cdp).catch(() => null);
    if (dryRun) {
      return { ok: true, code: 'DRY_RUN', message: `已填写并注入定位${address ? '：' + address : ''}，未提交`, screenshot: shotBefore, address, coords };
    }

    const clickedSubmit = await clickText(cdp, submitPattern);
    if (!clickedSubmit) {
      return { ok: false, code: 'NO_SUBMIT', message: '找不到提交/签到按钮（可用 submitPattern 覆盖）', screenshot: shotBefore, coords };
    }
    const deadline = Date.now() + 30000;
    let body = '';
    while (Date.now() < deadline) {
      await sleep(800);
      body = await cdp.eval('document.body.innerText || ""').catch(() => '');
      if (hit(body, successKeywords) || hit(body, alreadyKeywords)) break;
    }
    const shotAfter = await screenshot(cdp).catch(() => null);
    const succeeded = hit(body, successKeywords);
    const already = !succeeded && hit(body, alreadyKeywords);
    const excerpt = body.split('\n').filter((l) => l.trim()).slice(0, 12).join(' | ');
    return {
      ok: succeeded || already,
      code: succeeded ? 'SUCCESS' : already ? 'ALREADY' : 'UNCONFIRMED',
      message: succeeded ? '页面提示提交/签到成功' : already ? '页面提示已签到/已完成' : '提交后未检测到明确成功提示，请人工核对截图',
      excerpt,
      screenshot: shotAfter,
      address,
      coords,
    };
  } catch (e) {
    const shot = await screenshot(cdp).catch(() => null);
    return { ok: false, code: 'ERROR', message: e.message, screenshot: shot, coords };
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
