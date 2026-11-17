/**
 * Minimal Chrome DevTools Protocol driver (no puppeteer/playwright).
 *
 * Capabilities used by the check-in tools:
 *   - launch a headless Chrome with a remote debugging port
 *   - open a URL, evaluate JS, click/type, screenshot
 *   - override geolocation (virtual location) + grant the permission
 *   - read/write cookies and localStorage (to pull a token out of a logged-in page)
 *   - capture network requests (to reverse a site's API protocol)
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep } from './util.js';

// Persistent browser records so multi-step CLI calls (separate processes) can
// re-attach to a Chrome launched by an earlier command (login-open → login-finish,
// browser open → capture).
const STATE_DIR = process.env.CHECKIN_STATE_DIR || path.join(os.homedir(), '.dsh', 'checkin');
const BROWSER_FILE = path.join(STATE_DIR, 'browsers.json');
function readBrowsers() {
  try {
    return JSON.parse(fs.readFileSync(BROWSER_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}
function writeBrowsers(obj) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(BROWSER_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

const CHROME_CANDIDATES_WIN = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const CHROME_CANDIDATES_NIX = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  '/usr/local/bin/chromium',
];

export function findChrome(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const env = process.env.CHROME_PATH || process.env.CHROME_BIN;
  if (env && fs.existsSync(env)) return env;
  const list = process.platform === 'win32' ? CHROME_CANDIDATES_WIN : CHROME_CANDIDATES_NIX;
  for (const c of list) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  if (process.platform !== 'win32') {
    const which = spawnSync('which', ['google-chrome', 'chromium', 'chromium-browser', 'chrome'], { encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split('\n')[0];
  }
  return null;
}

/** Launch Chrome and resolve once the debug endpoint is live. */
export async function launchChrome({ port, headless = true, userDataDir, chromePath } = {}) {
  const exe = findChrome(chromePath);
  if (!exe) {
    throw new Error(
      '找不到 Chrome/Chromium/Edge。请安装 Chrome，或用配置项 chromePath / 环境变量 CHROME_PATH 指定可执行文件路径。',
    );
  }
  const dbgPort = port || 9333 + Math.floor(Math.random() * 500);
  const profile = userDataDir || path.join(os.tmpdir(), `dsh-checkin-${process.pid}-${Date.now()}`);
  if (!userDataDir) fs.rmSync(profile, { recursive: true, force: true });
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const args = [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${dbgPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    '--lang=zh-CN',
    '--window-size=460,900',
    'about:blank',
  ];
  if (isRoot || process.env.WPS_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy) args.push('--proxy-server=' + proxy);

  const proc = spawn(exe, args, { stdio: 'ignore' });
  try {
    proc.unref();
  } catch {
    /* allow the CLI process to exit while Chrome keeps running */
  }
  const base = `http://127.0.0.1:${dbgPort}`;
  for (let i = 0; i < 160; i++) {
    await sleep(250);
    try {
      const r = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const version = await r.json();
        const cleanup = () => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          if (!userDataDir) {
            setTimeout(() => {
              try {
                fs.rmSync(profile, { recursive: true, force: true });
              } catch {
                /* ignore */
              }
            }, 400);
          }
        };
        return { exe, proc, base, port: dbgPort, profile, version, cleanup };
      }
    } catch {
      /* not ready yet */
    }
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  throw new Error('Chrome 启动超时（调试端口未就绪）。若在容器/root 下运行，请设置 WPS_NO_SANDBOX=1。');
}

/** One CDP websocket session bound to a page target. */
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.method || ''} ${msg.error.message}`.trim())) : resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) {
          try {
            l(msg);
          } catch {
            /* ignore listener errors */
          }
        }
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 60000);
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  async eval(expression, awaitPromise = true) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) {
      throw new Error('页面脚本异常: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result.value;
  }
}

/** Connect to the first page target of a browser handle. */
export async function connectFirstPage(browser) {
  const list = await (await fetch(`${browser.base}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  const pages = list.filter((t) => t.type === 'page');
  const page = pages.find((p) => p.url && p.url !== 'about:blank') || pages[pages.length - 1] || list[0];
  if (!page) throw new Error('没有可用的页面目标');
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, targetId: page.id };
}

// ---------------------------------------------------------------------------
// Browser registry so multi-step tool calls can share one Chrome instance.
// ---------------------------------------------------------------------------
const browsers = new Map();

export async function getOrLaunch(id = 'default', opts = {}) {
  const existing = browsers.get(id);
  if (existing && existing.browser) {
    try {
      const r = await fetch(`${existing.browser.base}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return existing;
    } catch {
      /* stale, relaunch */
    }
    closeBrowser(id);
  }
  // Re-attach to a browser a previous CLI process persisted.
  const persisted = readBrowsers()[id];
  if (persisted && persisted.base) {
    try {
      const r = await fetch(`${persisted.base}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const entry = { id, browser: { base: persisted.base, port: persisted.port, exe: persisted.exe, cleanup: () => {} }, cdp: null };
        browsers.set(id, entry);
        return entry;
      }
    } catch {
      /* stale persisted record */
    }
    const all = readBrowsers();
    delete all[id];
    writeBrowsers(all);
  }
  const browser = await launchChrome(opts);
  const entry = { id, browser, cdp: null };
  browsers.set(id, entry);
  const all = readBrowsers();
  all[id] = { base: browser.base, port: browser.port, exe: browser.exe };
  writeBrowsers(all);
  return entry;
}

export function getEntry(id = 'default') {
  return browsers.get(id);
}

export async function getCdp(id = 'default', opts = {}) {
  const entry = await getOrLaunch(id, opts);
  if (!entry.cdp) {
    const { cdp } = await connectFirstPage(entry.browser);
    entry.cdp = cdp;
  }
  return entry;
}

export function closeBrowser(id = 'default') {
  const all = readBrowsers();
  const persisted = all[id];
  if (persisted) {
    delete all[id];
    writeBrowsers(all);
  }
  const entry = browsers.get(id);
  const base = entry?.browser?.base || persisted?.base;
  // Re-attached (no local proc): ask the remote Chrome to close over CDP.
  if (base) {
    (async () => {
      try {
        const list = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
        const page = list.find((t) => t.type === 'page') || list[0];
        if (page) {
          const cdp = await CDP.connect(page.webSocketDebuggerUrl);
          await cdp.send('Browser.close');
          cdp.close();
        }
      } catch {
        /* already gone */
      }
    })();
  }
  if (!entry) return !!base;
  try {
    entry.cdp?.close();
  } catch {
    /* ignore */
  }
  try {
    entry.browser.cleanup();
  } catch {
    /* ignore */
  }
  browsers.delete(id);
  return true;
}

export function listBrowsers() {
  return [...browsers.values()].map((e) => ({ id: e.id, port: e.browser.port, exe: e.browser.exe }));
}

/**
 * Close this process's CDP websockets and drop in-memory handles WITHOUT killing
 * Chrome. Persisted records stay, so a later CLI call can re-attach. Lets a
 * one-shot CLI command exit while the browser it launched keeps running.
 */
export function detachAll() {
  for (const entry of browsers.values()) {
    try {
      entry.cdp?.close();
    } catch {
      /* ignore */
    }
  }
  browsers.clear();
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

export async function waitFor(cdp, expr, timeoutMs = 20000, pollMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await cdp.eval(`!!(${expr})`)) return true;
    } catch {
      /* keep waiting */
    }
    await sleep(pollMs);
  }
  return false;
}

export async function clickSelector(cdp, selector) {
  const rect = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) return false;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  return true;
}

export async function clickText(cdp, text) {
  const rect = await cdp.eval(`(() => {
    const t = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll('div,span,button,[role="button"],a')].filter(e => (e.innerText || '').trim().includes(t));
    if (!els.length) return null;
    const el = els[els.length - 1];
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) return false;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  return true;
}

export async function typeInto(cdp, selector, text) {
  const focused = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return true;
  })()`);
  if (!focused) return false;
  await sleep(150);
  await cdp.send('Input.insertText', { text: String(text) });
  await sleep(200);
  let val = await cdp.eval(`(document.querySelector(${JSON.stringify(selector)})||{}).value || ''`);
  if (val !== String(text)) {
    await cdp.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(String(text))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(200);
    val = await cdp.eval(`(document.querySelector(${JSON.stringify(selector)})||{}).value || ''`);
  }
  return val === String(text);
}

export async function screenshot(cdp, file) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const out = file || path.join(os.tmpdir(), `dsh-checkin-shot-${Date.now()}.png`);
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  return out;
}

/** Grant geolocation for an origin and override the reported position. */
export async function setGeolocation(cdp, { latitude, longitude, accuracy = 30, origin }) {
  try {
    if (origin) await cdp.send('Browser.grantPermissions', { origin, permissions: ['geolocation'] });
  } catch {
    /* grant may fail; the JS stub below still works */
  }
  await cdp.send('Emulation.setGeolocationOverride', { latitude, longitude, accuracy });
}

/** Install a navigator.geolocation stub that always returns the given point. */
export async function addGeoStub(cdp, { latitude, longitude, accuracy = 30 }) {
  const src = `(function(){
    const lat=${Number(latitude)}, lon=${Number(longitude)}, acc=${Number(accuracy)};
    const pos=()=>({coords:{latitude:lat,longitude:lon,accuracy:acc,altitude:null,altitudeAccuracy:null,heading:null,speed:null},timestamp:Date.now()});
    if(navigator.geolocation){
      navigator.geolocation.getCurrentPosition=(ok)=>setTimeout(()=>ok(pos()),300);
      navigator.geolocation.watchPosition=(ok)=>{const t=setTimeout(()=>ok(pos()),300);return t;};
      navigator.geolocation.clearWatch=(t)=>clearTimeout(t);
    }
  })();`;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  return true;
}

export async function getCookies(cdp, domain) {
  const { cookies } = await cdp.send('Network.getAllCookies');
  return (cookies || []).filter((c) => {
    if (!domain) return true;
    const d = String(c.domain || '').replace(/^\./, '');
    return d === domain || d.endsWith('.' + domain);
  });
}

export async function setCookies(cdp, cookies) {
  await cdp.send('Network.enable');
  for (const c of cookies || []) {
    const p = { name: c.name, value: String(c.value), domain: c.domain, path: c.path || '/' };
    if (c.secure != null) p.secure = !!c.secure;
    if (c.httpOnly != null) p.httpOnly = !!c.httpOnly;
    if (c.expires && c.expires > 0) p.expires = c.expires;
    if (c.sameSite && ['Strict', 'Lax', 'None'].includes(c.sameSite)) p.sameSite = c.sameSite;
    try {
      await cdp.send('Network.setCookie', p);
    } catch {
      /* ignore individual cookie failures */
    }
  }
}

/** Read localStorage / sessionStorage as an object. */
export async function getStorage(cdp, kind = 'local') {
  const store = kind === 'session' ? 'sessionStorage' : 'localStorage';
  return cdp.eval(`(() => { const o = {}; try { for (let i=0;i<${store}.length;i++){const k=${store}.key(i);o[k]=${store}.getItem(k);} } catch(e){} return o; })()`);
}

/**
 * Navigate to a URL and record network requests for `waitMs`.
 * Returns concise request records to reverse an API protocol.
 */
export async function captureNetwork(cdp, { url, waitMs = 6000, includeStatic = false, max = 200 } = {}) {
  await cdp.send('Network.enable');
  const records = [];
  const byId = new Map();
  const isStatic = (u) => /\.(png|jpe?g|gif|webp|svg|css|woff2?|ttf|ico|mp4|map)(\?|$)/i.test(u);
  const off = cdp.on((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      const { requestId, request } = msg.params;
      const rec = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        postData: request.postData,
        status: null,
        responseHeaders: undefined,
        ts: Date.now(),
      };
      byId.set(requestId, rec);
      if (includeStatic || !isStatic(request.url)) records.push(rec);
    } else if (msg.method === 'Network.responseReceived') {
      const rec = byId.get(msg.params.requestId);
      if (rec) {
        rec.status = msg.params.response.status;
        rec.responseHeaders = msg.params.response.headers;
        rec.mimeType = msg.params.response.mimeType;
      }
    }
  });
  try {
    if (url) await cdp.send('Page.navigate', { url });
    await sleep(waitMs);
  } finally {
    off();
  }
  return records.slice(0, max).map((r) => ({
    method: r.method,
    url: r.url,
    status: r.status,
    postData: r.postData ? String(r.postData).slice(0, 2000) : undefined,
    contentType: r.responseHeaders && (r.responseHeaders['Content-Type'] || r.responseHeaders['content-type']),
    authHeader: r.headers && (r.headers.Authorization || r.headers.authorization || r.headers.token || r.headers.Token),
  }));
}
