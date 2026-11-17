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
import * as xqd from './lib/xiaoqiandao.js';
import { runWebSign } from './lib/webform.js';

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
      'groups: doctor | guide | token | geo | browser | qun100 | ketangpai | wps | xiaoqiandao | web | api | sign\n' +
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
  for (const pl of ['qun100', 'ketangpai', 'wps', 'xiaoqiandao']) {
    if (pl === 'wps') {
      const jar = await getGrant(null, 'wps');
      checks.push({ name: 'token:' + pl, ok: Array.isArray(jar) && jar.length > 0, detail: Array.isArray(jar) && jar.length ? `${jar.length} 条 Cookie` : '未登录' });
    } else {
      const t = await getToken(null, pl);
      checks.push({ name: 'token:' + pl, ok: !!t, detail: t ? mask(t) : '未登录' });
    }
  }
  const nets = { qun100: 'https://form.qun100.com/', ketangpai: 'https://openapiv5.ketangpai.com/', wps: 'https://f-api.wps.cn/', xiaoqiandao: 'https://m.xiaoqiandao.com/' };
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

async function doXiaoqiandao(action, args) {
  const act = (action || 'guide').replace(/-/g, '_');
  if (act === 'guide' || act === '') {
    return {
      ok: true,
      summary: [
        '小小签到(xiaoqiandao) 玩法（分享链接形如 https://m.xiaoqiandao.com/?cid=123...）：',
        '1) 登录：xiaoqiandao login-qr → 微信扫码 → xiaoqiandao login-poll',
        '2) 查看：xiaoqiandao detail --url "<分享链接>"（或 list 看自己的签到）',
        '3) 签到（普通/会议）：xiaoqiandao sign --url "<分享链接>"，再 verify 复核',
        '4) 位置签到：xiaoqiandao web-sign --url "<分享链接>" --lat .. --lng ..（浏览器注入定位）',
        '5) 未知变体：xiaoqiandao capture --url "<分享链接>" 抓 /xcx/* 接口后用 api 回放',
      ].join('\n'),
    };
  }
  if (act === 'login_qr' || act === 'login') {
    const q = await xqd.loginQr();
    await setGrant(null, 'xiaoqiandao-qr', { qrToken: q.qrToken, qrcode: q.qrcode, createdAt: Date.now() });
    return { ok: true, mode: 'qr', qrcode: q.qrcode, summary: `请用微信扫码登录小小签到；扫码完成后运行：xiaoqiandao login-poll\n二维码：${q.qrcode || '(接口未返回)'}` };
  }
  if (act === 'login_poll') {
    const g = await getGrant(null, 'xiaoqiandao-qr');
    const qrToken = args.qrToken || args.token || (g && g.qrToken);
    const r = await xqd.loginPoll(qrToken, { timeoutMs: Number(args.timeoutMs) || 150000 });
    await setToken(null, 'xiaoqiandao', r.token);
    return { ok: true, masked: mask(r.token), summary: `小小签到登录成功（${mask(r.token)}）` };
  }
  if (act === 'detail') {
    const cid = xqd.parseCid(args.url || args.cid);
    const token = args.token || (await getToken(null, 'xiaoqiandao'));
    const d = await xqd.detail(cid, { token });
    const s = xqd.summarizeDetail(cid, d);
    return { ok: true, ...s, summary: `小小签到：${s.title || ''}\ncid=${cid} 类型=${s.templateName} 需定位=${s.needLocation ? '是' : '否'}${s.range > 0 ? `（电子围栏 ${s.range} 米）` : ''}${s.geoFillField ? ' [地理位置字段]' : ''}\n已签到=${s.signedNow ? '是' : s.hasCheckedCount > 0 ? `${s.hasCheckedCount}/${s.limit}` : '否'} 已结束=${s.ended ? '是' : '否'} 可签时段=${s.inWindow ? '是' : '否'}\n时间：${s.startDate || '-'} ~ ${s.endDate || '-'}` };
  }
  if (act === 'list') {
    const token = args.token || (await getToken(null, 'xiaoqiandao'));
    if (!token) return { ok: false, needsToken: true, summary: '尚未登录小小签到：先 xiaoqiandao login-qr 扫码登录。' };
    const rows = await xqd.list({ token, keyword: args.keyword, count: Number(args.count) || 20 });
    return { ok: true, items: rows, summary: rows.length ? rows.map((r) => `${r.hasCheck ? '✅' : '⬜'} ${r.title}  ${r.cid}${r.isEnd ? ' (已结束)' : ''}`).join('\n') : '没有找到签到活动' };
  }
  if (act === 'verify') {
    const cid = xqd.parseCid(args.url || args.cid);
    const token = args.token || (await getToken(null, 'xiaoqiandao'));
    const d = await xqd.detail(cid, { token });
    const s = xqd.summarizeDetail(cid, d);
    return { ok: true, ...s, summary: `${s.title || ''}：${s.hasChecked ? '✅ 已签到' : '❌ 未签到'}${s.isEnd ? '（已结束）' : ''}` };
  }
  if (act === 'sign') {
    const token = args.token || (await getToken(null, 'xiaoqiandao'));
    if (!token) return { ok: false, needsToken: true, summary: '尚未登录小小签到：先 xiaoqiandao login-qr 扫码登录。' };
    const cid = xqd.parseCid(args.url || args.cid);
    const d = await xqd.detail(cid, { token });
    const s = xqd.summarizeDetail(cid, d);
    if (s.signedNow) return { ok: true, alreadySigned: true, summary: `ℹ️ 已签到（${s.hasCheckedCount}/${s.limit}），无需重复` };
    if (s.ended) return { ok: false, code: 'ENDED', summary: '签到已结束' };
    if (s.scanRequired) return { ok: false, code: 'NEED_SCAN', summary: '该签到需要扫码参与，只能用小程序/现场扫码。' };
    if (s.reqToken) return { ok: false, code: 'NEED_TOKEN', summary: '该签到需要口令后才能加入。' };
    if (s.wifiRequired) return { ok: false, code: 'NEED_WIFI', summary: '该签到需要连接指定 WiFi，需在手机端。' };
    const hasCoords = Number.isFinite(Number(args.lat)) && Number.isFinite(Number(args.lng));
    if (s.geoFence && !s.geoFillField && !hasCoords) {
      return { ok: false, code: 'NEED_MINIPROGRAM', summary: '该签到使用电子围栏定位，H5 端无法提交。请：①用小程序签到；②或 xiaoqiandao capture 抓小程序请求后用 api 回放；③如确知坐标可加 --lat/--lng 尝试。' };
    }
    if (s.geoFillField && !hasCoords) {
      return { ok: false, code: 'NEED_LOCATION', summary: '该签到需要填写地理位置，请给 --lat/--lng（可先 geo geocode 一个地点）。' };
    }
    try {
      const r = await xqd.submit(cid, { token, lat: args.lat, lng: args.lng, address: args.address, detailData: d, joinFirst: s.regRequired });
      const rd = r.data || {};
      return { ok: true, strategy: r.strategy, data: rd, summary: `✅ 小小签到成功（${r.strategy}）${rd.count != null ? `，累计 ${rd.count} 次` : ''}${rd.rank != null ? `，排名 ${rd.rank}` : ''}（cid=${cid}）` };
    } catch (e) {
      return { ok: false, code: e.code || 'SIGN_FAILED', message: e.message, summary: '小小签到提交失败：' + (e.message || e) };
    }
  }
  if (act === 'web_sign') {
    const r = await runWebSign({
      url: args.url,
      name: args.name,
      studentId: args.studentId,
      place: args.place,
      lat: args.lat,
      lng: args.lng,
      headless: args.headless === true,
      submitPattern: args.submitPattern || '签到|打卡|立即签到|确认签到|提交',
      successKeywords: ['签到成功', '打卡成功', '已签到', '提交成功', '签到完成'],
      alreadyKeywords: ['已签到', '今日已签到', '已完成', '不能重复'],
      chromePath: args.chromePath,
    });
    return { ...r, summary: `${r.ok ? '✅' : '❌'} 小小签到(浏览器)：${r.message}${r.screenshot ? '\n截图：' + r.screenshot : ''}` };
  }
  if (act === 'capture') {
    const r = await xqd.capture(args.url, { waitMs: Number(args.waitMs) || 8000 });
    return { ok: true, ...r, summary: `抓包 ${r.endpoints.length} 条 /xcx/* 请求：\n` + r.endpoints.map((x) => `${x.method} ${x.url}`).slice(0, 30).join('\n') + '\n可用 checkin.mjs api 回放。' };
  }
  return { ok: false, summary: `未知动作 ${action}（可用：guide/login-qr/login-poll/detail/sign/web-sign/capture）` };
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

  if (group === 'xiaoqiandao') {
    const xrest = argv.slice(1);
    const xargs = parseFlags(xrest);
    const xact = (xrest.find((t) => !t.startsWith('--')) || '').replace(/-/g, '_');
    let result;
    try {
      result = await doXiaoqiandao(xact, xargs);
    } catch (e) {
      result = { ok: false, error: { code: e.code || 'ERROR', message: e.message }, summary: '小小签到出错：' + (e.message || e) };
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    setTimeout(() => process.exit(result && result.ok === false ? 1 : 0), 250);
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
