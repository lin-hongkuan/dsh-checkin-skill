#!/usr/bin/env node
/**
 * checkin skill CLI — thin dispatch over the same handlers used by the (retired) plugin.
 * Every command prints one JSON object to stdout (agent-friendly); logs/summaries are
 * in the `summary` field. Never prints full tokens (masked only).
 *
 * Usage:
 *   node checkin.mjs guide [--platform qun100]
 *   node checkin.mjs token list|get|set|clear|login-open|login-finish --platform X [--token ...]
 *   node checkin.mjs geo geocode --place "..." [--amap-key ...] [--form-url ...]
 *   node checkin.mjs geo convert --lat 23 --lng 113 --from gcj02 --to wgs84
 *   node checkin.mjs geo parse --place "<map url>"
 *   node checkin.mjs qun100 login-qr | login-poll | status | inspect | sign | verify | doctor
 *   node checkin.mjs ketangpai doctor | courses | pending | attendance | sign | checkout
 *   node checkin.mjs wps locate | import-cookie | status | sign
 *   node checkin.mjs web --url ... --name ... --student-id ... [--place ...] [--dry-run]
 *   node checkin.mjs api --method POST --url ... --headers '{...}' --body '{...}' [--lat .. --lng ..]
 *   node checkin.mjs browser open --url ... | screenshot | storage --kind local | capture --url ...
 */
import { buildTools } from './lib/tools.js';
import { detachAll, launchChrome, connectFirstPage, getStorage, getCookies, findChrome } from './lib/cdp.js';
import { setToken, setGrant, getToken, getGrant, mask } from './lib/creds.js';
import { sleep } from './lib/util.js';
import * as qun from './lib/qun100.js';

const GROUPS = {
  guide: 'checkin_guide',
  token: 'checkin_token',
  geo: 'checkin_geo',
  browser: 'checkin_browser',
  qun100: 'checkin_qun100',
  ketangpai: 'checkin_ketangpai',
  wps: 'checkin_wps',
  web: 'checkin_web',
  api: 'checkin_api',
  sign: 'checkin_sign',
};

const ACTION_TOOLS = new Set(['checkin_token', 'checkin_geo', 'checkin_browser', 'checkin_qun100', 'checkin_ketangpai', 'checkin_wps']);

const VERSION = '1.1.0';

const ctx = {
  tools: { register: () => () => {} },
  credentials: {},
  systemPrompt: { section: () => () => {} },
};

function toCamel(k) {
  return k.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function parseFlags(tokens) {
  const out = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('--')) continue;
    const key = toCamel(t.slice(2));
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    i++;
    let v = next;
    if (/^[\[{]/.test(v) || /^-?\d+(\.\d+)?$/.test(v) || v === 'true' || v === 'false') {
      try {
        v = JSON.parse(v);
      } catch {
        /* keep string */
      }
    }
    if (out[key] !== undefined) {
      out[key] = Array.isArray(out[key]) ? [...out[key], v] : [out[key], v];
    } else {
      out[key] = v;
    }
  }
  return out;
}

function printUsage() {
  console.error(
    'checkin <group> [action] [--flags]\n' +
      'groups: doctor | guide | token | geo | browser | qun100 | ketangpai | wps | web | api | sign\n' +
      'example: checkin qun100 sign --url "<link>" --student 20230000\n' +
      '         checkin token login --platform ketangpai',
  );
}

/**
 * Single-command blocking browser login. The harness runs each command in a job
 * that kills child processes on exit, so the browser cannot survive between
 * commands — the whole open → user logs in → read token loop must happen in ONE call.
 */
async function doLogin(args) {
  const platform = args.platform;
  const timeoutMs = Number(args.timeoutMs) || 180000;
  if (platform === 'qun100') {
    const qr = await qun.createLoginQr();
    const png = await qun.renderQr(qr.qrUrl);
    await setGrant(null, 'qun100-pending', { scene: qr.scene, qrUrl: qr.qrUrl, createdAt: Date.now() });
    return { ok: true, mode: 'qr', scene: qr.scene, qrUrl: qr.qrUrl, qrPng: png, summary: `请用微信扫码登录群报数；扫码完成后运行：qun100 login-poll\n二维码：${png || qr.qrUrl}` };
  }
  const urls = { ketangpai: 'https://w.ketangpai.com/', wps: 'https://account.wps.cn/' };
  if (!urls[platform]) return { ok: false, summary: `不支持的平台：${platform}（ketangpai / wps；群报数用 qun100 login-qr）` };

  let chrome;
  try {
    chrome = await launchChrome({ headless: false });
  } catch (e) {
    return { ok: false, summary: `无法打开浏览器：${e.message}（可改用 token set 粘贴）` };
  }
  let cdp;
  try {
    const conn = await connectFirstPage(chrome);
    cdp = conn.cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.navigate', { url: urls[platform] });
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(2500);
      if (platform === 'ketangpai') {
        const s = await getStorage(cdp, 'local').catch(() => ({}));
        let tk = s.token || s.token_for_login;
        if (!tk) {
          const k = Object.keys(s).find((key) => /token/i.test(key) && typeof s[key] === 'string' && s[key].length > 8);
          if (k) tk = s[k];
        }
        if (tk) {
          await setToken(null, platform, tk);
          return { ok: true, platform, masked: mask(tk), summary: `已从浏览器读取课堂派 token 并保存（${mask(tk)}）` };
        }
      } else {
        const jar = await getCookies(cdp, 'wps.cn').catch(() => []);
        if (jar.some((c) => /^(wps_sid|kso_sid)$/.test(c.name) && c.value)) {
          await setGrant(null, 'wps', jar);
          return { ok: true, platform, count: jar.length, summary: `已读取 WPS 登录态（${jar.length} 条 Cookie）` };
        }
      }
    }
    return { ok: false, timeout: true, summary: `等待登录超时（${Math.round(timeoutMs / 1000)}s）。请确认已在打开的浏览器里完成登录，或改用 token set 粘贴。` };
  } catch (e) {
    return { ok: false, summary: '登录流程失败：' + (e.message || e) };
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

async function doDoctor() {
  const checks = [];
  const major = Number(String(process.versions.node).split('.')[0]);
  checks.push({ name: 'node', ok: major >= 22, detail: `${process.version}（需要 >= 22 才有内置 WebSocket）` });
  const chrome = findChrome();
  checks.push({ name: 'chrome', ok: !!chrome, detail: chrome || '未找到 Chrome/Edge（浏览器类功能不可用）' });
  for (const pl of ['qun100', 'ketangpai', 'wps']) {
    if (pl === 'wps') {
      const jar = await getGrant(null, 'wps');
      checks.push({ name: 'token:' + pl, ok: Array.isArray(jar) && jar.length > 0, detail: Array.isArray(jar) && jar.length ? `${jar.length} 条 Cookie` : '未登录' });
    } else {
      const t = await getToken(null, pl);
      checks.push({ name: 'token:' + pl, ok: !!t, detail: t ? mask(t) : '未登录' });
    }
  }
  const nets = { qun100: 'https://form.qun100.com/', ketangpai: 'https://openapiv5.ketangpai.com/', wps: 'https://f-api.wps.cn/' };
  for (const [k, u] of Object.entries(nets)) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
      checks.push({ name: 'net:' + k, ok: true, detail: 'HTTP ' + r.status });
    } catch (e) {
      checks.push({ name: 'net:' + k, ok: false, detail: e.message });
    }
  }
  const okAll = checks.filter((c) => c.name === 'node' || c.name === 'chrome').every((c) => c.ok);
  return { ok: okAll, checks, summary: '自检：\n' + checks.map((c) => `${c.ok ? '✅' : '⚠️'} ${c.name}：${c.detail}`).join('\n') };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(VERSION + '\n');
    return;
  }
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    printUsage();
    process.exitCode = 2;
    return;
  }
  const group = argv[0];

  if (group === 'doctor') {
    const result = await doDoctor();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    setTimeout(() => process.exit(result.ok ? 0 : 1), 250);
    return;
  }

  const toolName = GROUPS[group];
  if (!toolName) {
    console.error(`unknown group "${group}"`);
    printUsage();
    process.exitCode = 2;
    return;
  }

  let rest = argv.slice(1);
  const args = parseFlags(rest);
  const actionToken = rest.find((t) => !t.startsWith('--'));
  if (ACTION_TOOLS.has(toolName)) {
    // The sub-command is the action; normalise kebab-case to the tool's snake_case.
    args.action = String(actionToken || args.action || '').replace(/-/g, '_');
    if (!args.action) {
      console.error(`"${group}" needs an action, e.g. ${group} ${group === 'qun100' ? 'sign' : 'list'}`);
      process.exitCode = 2;
      return;
    }
  }

  if (group === 'token' && args.action === 'login') {
    const result = await doLogin(args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    setTimeout(() => process.exit(result && result.ok === false ? 1 : 0), 250);
    return;
  }

  const { tools } = buildTools({ ctx, config: {} });
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    console.error(`internal: tool ${toolName} not found`);
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = await tool.execute(args, { signal: AbortSignal.timeout(600000) });
  } catch (e) {
    result = { ok: false, error: { code: e.code || 'ERROR', message: e.message } };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  // Drop this process's CDP sockets so a launched Chrome keeps running for the next
  // command (login-finish / capture). Then exit after a short grace period: a
  // delayed process.exit avoids Node 25's libuv assertion on a closing fetch/ws
  // handle, while guaranteeing the one-shot CLI does not hang on a lingering socket.
  try {
    detachAll();
  } catch {
    /* ignore */
  }
  const code = result && result.ok === false ? 1 : 0;
  setTimeout(() => process.exit(code), 250);
}

main();
