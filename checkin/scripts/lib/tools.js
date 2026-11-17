/** Tool definitions exposed by the checkin plugin. */
import { renderText, sleep, num } from './util.js';
import { getToken, setToken, clearToken, getGrant, setGrant, mask, persistenceAvailable } from './creds.js';
import * as geo from './geo.js';
import * as qun from './qun100.js';
import * as ktp from './ketangpai.js';
import * as wps from './wps.js';
import { replay } from './apireplay.js';
import { runWebSign } from './webform.js';
import { renderReceipt } from './receipt.js';
import { PLATFORMS, platformGuide, buildSystemPrompt } from './knowledge.js';
import {
  getOrLaunch, getCdp, getEntry, closeBrowser, listBrowsers, connectFirstPage,
  screenshot, setGeolocation, addGeoStub, getCookies, setCookies, getStorage, captureNetwork,
  clickSelector, clickText, typeInto,
} from './cdp.js';

function cfgOf(config) {
  const c = config || {};
  return {
    amapKey: c.amapKey || process.env.AMAP_KEY,
    tencentKey: c.tencentKey || process.env.TENCENT_MAP_KEY,
    chromePath: c.chromePath || process.env.CHROME_PATH,
    latitude: c.latitude ?? c.lat,
    longitude: c.longitude ?? c.lng,
    coordsAreWgs84: c.coordsAreWgs84 === true,
    requireGpsCoords: c.requireGpsCoords === true,
  };
}

function tool(name, description, parameters, execute, opts = {}) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value && typeof value.summary === 'string' && value.summary ? value.summary : renderText(value) }],
    },
    execute: async (args, exec) => execute(args || {}, exec),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  };
}

async function makeReceipt(data) {
  try {
    return await renderReceipt(data);
  } catch {
    return null;
  }
}

const S = { type: 'string' };
const N = { type: 'number' };
const B = { type: 'boolean' };

export function buildTools({ ctx, config }) {
  const C = cfgOf(config);
  const persist = persistenceAvailable(ctx);

  // ---------------------------------------------------------------- checkin_guide
  const guide = tool(
    'checkin_guide',
    '签到玩法与登录态指引。查看各平台（群报数/课堂派/WPS/网页表单/微信小程序）如何签到、如何获取 token，以及当前已保存的登录态。不确定流程时先调用它。platform 省略则返回全部。',
    {
      type: 'object',
      properties: { platform: { type: 'string', enum: ['qun100', 'ketangpai', 'wps', 'web', 'miniprogram'] } },
    },
    async (args) => {
      let status = {};
      for (const p of ['qun100', 'ketangpai', 'wps', 'xiaoqiandao']) {
        if (p === 'wps') {
          const jar = await getGrant(ctx, 'wps');
          status[p] = { configured: Array.isArray(jar) && jar.length > 0, detail: Array.isArray(jar) ? `${jar.length} 条 Cookie` : '未登录' };
        } else {
          const t = await getToken(ctx, p);
          status[p] = { configured: !!t, masked: t ? mask(t) : '' };
        }
      }
      const platforms = platformGuide(args.platform ? [args.platform] : undefined);
      return {
        ok: true,
        persistence: persist ? 'file' : 'memory-only',
        status,
        platforms,
        summary:
          `签到副驾驶已就绪。登录态：` +
          `群报数${status.qun100.configured ? '✅' : '❌'}、课堂派${status.ketangpai.configured ? '✅' : '❌'}、WPS${status.wps.configured ? '✅' : '❌'}。` +
          `\n获取 token/登录态首选让 agent 打开浏览器读取或发二维码，无需你手动翻开发者工具。`,
      };
    },
  );

  // ---------------------------------------------------------------- checkin_token
  const token = tool(
    'checkin_token',
    '管理各平台登录态。action=list 查看；get 查看单平台；set 保存用户提供的 token（课堂派/群报数）；clear 清除；login_open 打开浏览器登录页（或群报数二维码）供用户登录；login_finish 自动从浏览器读取 token/Cookie 并保存。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'set', 'clear', 'login_open', 'login_finish'] },
        platform: { type: 'string', enum: ['qun100', 'ketangpai', 'wps'] },
        token: { type: 'string', description: 'set 时要保存的 token' },
        browserId: { type: 'string', description: '登录浏览器实例 id，默认 login:<platform>' },
        waitMs: { type: 'number', description: 'login_finish(群报数轮询)/等待的毫秒数，默认 20000' },
      },
      required: ['action'],
    },
    async (args) => {
      const p = args.platform;
      if (args.action === 'list') {
        const out = {};
        for (const pl of ['qun100', 'ketangpai', 'wps']) {
          if (pl === 'wps') {
            const jar = await getGrant(ctx, 'wps');
            out[pl] = { configured: Array.isArray(jar) && jar.length > 0, detail: Array.isArray(jar) ? `${jar.length} 条 Cookie` : '未登录' };
          } else {
            const t = await getToken(ctx, pl);
            out[pl] = { configured: !!t, masked: t ? mask(t) : '' };
          }
        }
        return { ok: true, tokens: out, summary: `登录态：群报数${out.qun100.configured ? '✅' : '❌'} 课堂派${out.ketangpai.configured ? '✅' : '❌'} WPS${out.wps.configured ? '✅' : '❌'}` };
      }
      if (args.action === 'get') {
        if (p === 'wps') {
          const jar = await getGrant(ctx, 'wps');
          return { ok: Array.isArray(jar) && jar.length > 0, detail: Array.isArray(jar) ? `${jar.length} 条 Cookie` : '未登录', tokenHow: PLATFORMS.wps.tokenHow };
        }
        const t = await getToken(ctx, p);
        return { ok: !!t, masked: t ? mask(t) : '', configured: !!t, tokenHow: PLATFORMS[p]?.tokenHow };
      }
      if (args.action === 'set') {
        if (!p || !args.token) return { ok: false, summary: 'set 需要 platform 与 token' };
        await setToken(ctx, p, args.token.trim());
        return { ok: true, summary: `已保存 ${PLATFORMS[p]?.label || p} 的登录态（${mask(args.token)}）` };
      }
      if (args.action === 'clear') {
        if (p === 'wps') await setGrant(ctx, 'wps', []);
        else await clearToken(ctx, p);
        return { ok: true, summary: `已清除 ${p} 登录态` };
      }
      if (args.action === 'login_open') {
        if (p === 'qun100') {
          const qr = await qun.createLoginQr();
          const png = await qun.renderQr(qr.qrUrl);
          await setGrant(ctx, 'qun100-pending', { scene: qr.scene, qrUrl: qr.qrUrl, createdAt: Date.now() });
          return {
            ok: true,
            mode: 'qr',
            scene: qr.scene,
            qrUrl: qr.qrUrl,
            qrPng: png,
            summary: `二维码已生成，请用微信扫描登录群报数。扫码完成后调用 checkin_token login_finish（platform=qun100）。\n二维码图片：${png || qr.qrUrl}`,
          };
        }
        const id = args.browserId || `login:${p}`;
        const entry = await getOrLaunch(id, { headless: false, chromePath: C.chromePath });
        if (!entry.cdp) {
          const conn = await connectFirstPage(entry.browser);
          entry.cdp = conn.cdp;
        }
        const cdp = entry.cdp;
        const loginUrl = PLATFORMS[p]?.loginUrl || 'about:blank';
        await cdp.send('Page.navigate', { url: loginUrl });
        await sleep(1800);
        const shot = await screenshot(cdp).catch(() => null);
        return {
          ok: true,
          mode: 'browser',
          browserId: id,
          screenshot: shot,
          summary: `已打开浏览器（${loginUrl}）。请在该窗口登录 ${PLATFORMS[p]?.label || p}，登录完成后调用 checkin_token login_finish（platform=${p}, browserId=${id}）。${shot ? `\n当前截图：${shot}` : ''}`,
        };
      }
      if (args.action === 'login_finish') {
        const waitMs = num(args.waitMs) ?? 20000;
        if (p === 'qun100') {
          const pending = await getGrant(ctx, 'qun100-pending');
          if (!pending?.scene) return { ok: false, summary: '没有待完成的群报数登录，请先 checkin_token login_open（platform=qun100）' };
          const started = Date.now();
          while (Date.now() - started < waitMs) {
            await sleep(2500);
            const data = await qun.pollLoginResult(pending.scene).catch(() => null);
            if (data?.token) {
              await setToken(ctx, 'qun100', data.token);
              return { ok: true, summary: `群报数登录成功：${data.userInfo?.nickName || ''}（fuid=${data.fuid || ''}）` };
            }
          }
          return { ok: false, summary: '等待扫码超时，请重新生成二维码再扫一次。' };
        }
        const id = args.browserId || `login:${p}`;
        const entry = getEntry(id);
        if (!entry || !entry.cdp) return { ok: false, summary: `没有找到登录浏览器（${id}），请先 login_open。` };
        const cdp = entry.cdp;
        if (p === 'ketangpai') {
          const store = await getStorage(cdp, 'local').catch(() => ({}));
          const cookieStore = await getStorage(cdp, 'session').catch(() => ({}));
          const all = { ...cookieStore, ...store };
          let tk = all.token || all.token_for_login || all['token_for_login_'];
          if (!tk) {
            const k = Object.keys(all).find((key) => /token/i.test(key) && typeof all[key] === 'string' && all[key].length > 8);
            if (k) tk = all[k];
          }
          if (!tk) {
            const shot = await screenshot(cdp).catch(() => null);
            return { ok: false, screenshot: shot, summary: `浏览器里暂未找到课堂派 token，请确认已登录 w.ketangpai.com 后重试。${shot ? '\n截图：' + shot : ''}` };
          }
          await setToken(ctx, 'ketangpai', tk);
          await screenshot(cdp).catch(() => null);
          return { ok: true, summary: `已从浏览器读取课堂派 token 并保存（${mask(tk)}）` };
        }
        // wps
        await cdp.send('Page.navigate', { url: 'https://f.wps.cn/' }).catch(() => {});
        await sleep(2500);
        const jar = await getCookies(cdp, 'wps.cn').catch(() => []);
        if (!jar.length) return { ok: false, summary: '未读取到 WPS Cookie，请确认已登录 f.wps.cn 后重试。' };
        await setGrant(ctx, 'wps', jar);
        return { ok: true, summary: `已读取并保存 WPS 登录态（${jar.length} 条 Cookie，含续期凭证：${wps.hasRefreshCredential(jar) ? '是' : '否'}）` };
      }
      return { ok: false, summary: '未知 action' };
    },
    { timeoutMs: 180000 },
  );

  // ---------------------------------------------------------------- checkin_geo
  const geoTool = tool(
    'checkin_geo',
    '地理与坐标工具。action: geocode(地名→坐标) / reverse(坐标→地址) / convert(坐标系互转 wgs84|gcj02|bd09) / distance(两点距离米) / parse(从地图链接抠坐标) / centroid(围栏多边形重心) / inside(点是否在多边形围栏内)。中国 App 用 GCJ-02、GPS/Google 用 WGS84、百度用 BD-09。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['geocode', 'reverse', 'convert', 'distance', 'parse', 'centroid', 'inside'] },
        place: { type: 'string' },
        lat: N,
        lng: N,
        from: { type: 'string' },
        to: { type: 'string' },
        aLat: N,
        aLng: N,
        bLat: N,
        bLng: N,
        polygon: { type: 'array', items: { type: 'array', items: N }, description: '[[lng,lat],...]' },
        city: { type: 'string' },
        formUrl: { type: 'string', description: '可选：群报数表单，geocode 时用其指定签到点做最权威坐标' },
      },
      required: ['action'],
    },
    async (args) => {
      const a = args.action;
      if (a === 'geocode') {
        let specified = null;
        if (args.formUrl) {
          const t = await getToken(ctx, 'qun100');
          if (t) {
            try {
              const fid = qun.parseFormUrl(args.formUrl);
              specified = qun.parseSpecified(await qun.catalog(t, fid));
            } catch {
              /* ignore */
            }
          }
        }
        const r = await geo.resolvePlace(args.place || '', { specified, city: args.city, amapKey: C.amapKey, tencentKey: C.tencentKey });
        return { ok: true, result: r, summary: `📍 ${r.title || args.place}\n坐标 ${r.latitude}, ${r.longitude}（${r.coordinateSystem || 'gcj02'}，来源 ${r.source}）${r.warning ? '\n⚠ ' + r.warning : ''}` };
      }
      if (a === 'reverse') {
        const r = await geo.reverseAmap(num(args.lat), num(args.lng), { key: C.amapKey });
        return { ok: true, ...r, summary: `地址：${r.address}` };
      }
      if (a === 'convert') {
        const r = geo.convert(num(args.lat), num(args.lng), args.from || 'wgs84', args.to || 'gcj02');
        return { ok: true, from: args.from, to: args.to, ...r, summary: `${args.from}→${args.to}: ${r.latitude}, ${r.longitude}` };
      }
      if (a === 'distance') {
        const d = geo.distanceMeters({ latitude: num(args.aLat), longitude: num(args.aLng) }, { latitude: num(args.bLat), longitude: num(args.bLng) });
        return { ok: true, meters: Math.round(d), summary: `两点距离约 ${Math.round(d)} 米` };
      }
      if (a === 'parse') {
        const r = geo.extractCoordsFromText(args.place || '');
        return { ok: !!r, ...(r || {}), summary: r ? `解析坐标 ${r.latitude}, ${r.longitude}` : '未从文本中解析到坐标' };
      }
      if (a === 'centroid') {
        const r = geo.polygonCentroid(args.polygon || []);
        return { ok: true, ...r, summary: `围栏重心 ${r.latitude}, ${r.longitude}` };
      }
      if (a === 'inside') {
        const inside = geo.pointInPolygon(num(args.lat), num(args.lng), args.polygon || []);
        const c = geo.polygonCentroid(args.polygon || []);
        const d = geo.distanceMeters({ latitude: num(args.lat), longitude: num(args.lng) }, c);
        return { ok: true, inside, metersToCenter: Math.round(d), summary: inside ? `在范围内（距中心 ${Math.round(d)} 米）` : `不在范围内（距中心 ${Math.round(d)} 米）` };
      }
      return { ok: false, summary: '未知 action' };
    },
  );

  // ---------------------------------------------------------------- checkin_browser
  const browser = tool(
    'checkin_browser',
    '通用浏览器（CDP）驱动与接口抓包。action: launch/close/list/open/geolocate(虚拟定位)/eval/screenshot/cookies(读Cookie)/storage(读localStorage)/capture(抓网络请求，用于扒接口协议)/click/type。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['launch', 'close', 'list', 'open', 'geolocate', 'eval', 'screenshot', 'cookies', 'storage', 'capture', 'click', 'type'] },
        browserId: { type: 'string' },
        url: { type: 'string' },
        headless: B,
        latitude: N,
        longitude: N,
        accuracy: N,
        expression: { type: 'string' },
        domain: { type: 'string' },
        kind: { type: 'string', enum: ['local', 'session'] },
        selector: { type: 'string' },
        text: { type: 'string' },
        waitMs: N,
        includeStatic: B,
      },
      required: ['action'],
    },
    async (args) => {
      const id = args.browserId || 'default';
      if (args.action === 'list') return { ok: true, browsers: listBrowsers(), summary: `浏览器实例：${listBrowsers().map((b) => b.id).join(', ') || '无'}` };
      if (args.action === 'close') return { ok: true, closed: closeBrowser(id), summary: `已关闭 ${id}` };
      if (args.action === 'launch') {
        const entry = await getOrLaunch(id, { headless: args.headless !== false, chromePath: C.chromePath });
        if (!entry.cdp) {
          const conn = await connectFirstPage(entry.browser);
          entry.cdp = conn.cdp;
        }
        return { ok: true, browserId: id, port: entry.browser.port, exe: entry.browser.exe, summary: `已启动浏览器 ${id}（端口 ${entry.browser.port}）` };
      }
      const { cdp } = await getCdp(id, { headless: args.headless !== false, chromePath: C.chromePath });
      // One-shot commands: if a url is given, navigate before acting (the browser
      // cannot be shared across separate CLI invocations).
      if (args.url && ['eval', 'storage', 'cookies', 'screenshot', 'click', 'type', 'geolocate'].includes(args.action)) {
        await cdp.send('Page.navigate', { url: args.url });
        await sleep(num(args.waitMs) ?? 2000);
      }
      if (args.action === 'open') {
        await cdp.send('Page.navigate', { url: args.url });
        await sleep(num(args.waitMs) ?? 2000);
        const title = await cdp.eval('document.title').catch(() => '');
        const snippet = await cdp.eval('(document.body && document.body.innerText || "").slice(0,800)').catch(() => '');
        const shot = await screenshot(cdp).catch(() => null);
        return { ok: true, title, snippet, screenshot: shot, summary: `已打开 ${args.url}\n标题：${title}${shot ? '\n截图：' + shot : ''}` };
      }
      if (args.action === 'geolocate') {
        await addGeoStub(cdp, { latitude: num(args.latitude), longitude: num(args.longitude), accuracy: num(args.accuracy) ?? 30 }).catch(() => {});
        await setGeolocation(cdp, { latitude: num(args.latitude), longitude: num(args.longitude), accuracy: num(args.accuracy) ?? 30, origin: args.url ? new URL(args.url).origin : undefined }).catch(() => {});
        return { ok: true, summary: `已注入虚拟定位 ${args.latitude}, ${args.longitude}` };
      }
      if (args.action === 'eval') {
        const v = await cdp.eval(args.expression || 'null');
        return { ok: true, value: v, summary: `eval 结果：${renderText(v).slice(0, 1000)}` };
      }
      if (args.action === 'screenshot') {
        const shot = await screenshot(cdp);
        return { ok: true, screenshot: shot, summary: `截图：${shot}` };
      }
      if (args.action === 'cookies') {
        const c = await getCookies(cdp, args.domain);
        return { ok: true, count: c.length, cookies: c, summary: `Cookie ${c.length} 条：${c.map((x) => x.name).join(', ')}` };
      }
      if (args.action === 'storage') {
        const s = await getStorage(cdp, args.kind || 'local');
        return { ok: true, storage: s, summary: `storage keys：${Object.keys(s).join(', ')}` };
      }
      if (args.action === 'capture') {
        const recs = await captureNetwork(cdp, { url: args.url, waitMs: num(args.waitMs) ?? 6000, includeStatic: args.includeStatic === true });
        return { ok: true, captured: recs, summary: `抓包 ${recs.length} 条请求：\n` + recs.map((r) => `${r.method} ${r.status ?? '?'} ${r.url}`).slice(0, 30).join('\n') };
      }
      if (args.action === 'click') {
        let done = false;
        if (args.selector) done = await clickSelector(cdp, args.selector);
        if (!done && args.text) done = await clickText(cdp, args.text);
        return { ok: done, summary: done ? '已点击' : '未找到可点击元素' };
      }
      if (args.action === 'type') {
        const done = await typeInto(cdp, args.selector, args.text || '');
        return { ok: done, summary: done ? '已输入' : '未找到输入框' };
      }
      return { ok: false, summary: '未知 action' };
    },
    { timeoutMs: 120000 },
  );

  // ---------------------------------------------------------------- checkin_qun100
  const qunTool = tool(
    'checkin_qun100',
    '群报数(qun100)签到。action: doctor/login_qr/login_poll/status/inspect/sign/verify。定位优先用表单指定签到点（不用给经纬度）；已签到幂等跳过。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['doctor', 'login_qr', 'login_poll', 'status', 'inspect', 'sign', 'verify'] },
        url: S,
        student: S,
        name: S,
        place: S,
        lat: N,
        lng: N,
        mapUrl: S,
        answers: { type: 'array', items: S, description: '"cid=值" 列表' },
        dryRun: B,
        force: B,
        token: S,
        amapKey: S,
      },
      required: ['action'],
    },
    async (args) => {
      const a = args.action;
      if (a === 'login_qr') {
        const qr = await qun.createLoginQr();
        const png = await qun.renderQr(qr.qrUrl);
        await setGrant(ctx, 'qun100-pending', { scene: qr.scene, qrUrl: qr.qrUrl, createdAt: Date.now() });
        return { ok: true, scene: qr.scene, qrUrl: qr.qrUrl, qrPng: png, summary: `请用微信扫码登录群报数，然后调用 checkin_qun100 login_poll。\n二维码：${png || qr.qrUrl}` };
      }
      if (a === 'login_poll') {
        const pending = await getGrant(ctx, 'qun100-pending');
        if (!pending?.scene) return { ok: false, summary: '没有待完成登录，请先 login_qr' };
        const started = Date.now();
        while (Date.now() - started < 30000) {
          await sleep(2500);
          const data = await qun.pollLoginResult(pending.scene).catch(() => null);
          if (data?.token) {
            await setToken(ctx, 'qun100', data.token);
            return { ok: true, summary: `群报数登录成功：${data.userInfo?.nickName || ''}` };
          }
        }
        return { ok: false, summary: '等待扫码超时' };
      }
      const t = args.token || (await getToken(ctx, 'qun100'));
      if (!t) return { ok: false, needsToken: true, tokenHow: PLATFORMS.qun100.tokenHow, summary: '尚未登录群报数。请调用 checkin_qun100 login_qr 生成二维码扫码，或 checkin_token login_open。' };

      if (a === 'doctor') {
        const d = await qun.doctor(t, { amapKey: args.amapKey || C.amapKey });
        return { ok: d.loggedIn, ...d, summary: `群报数自检：\n` + d.checks.map((c) => `${c.ok ? '✅' : '⚠️'} ${c.name}：${c.detail}`).join('\n') };
      }
      if (a === 'status') {
        const r = await qun.status(t, { url: args.url });
        return { ok: true, ...r, summary: `群报数：${r.nickname || ''}${r.form ? `\n${r.form.title} — ${r.form.statusText}${r.form.signed ? '（已签到）' : '（未签到）'}` : ''}` };
      }
      if (a === 'inspect') {
        const r = await qun.inspect(t, { url: args.url });
        return { ok: true, ...r, summary: `📋 ${r.title}（${r.statusText}）\n题目：${r.questions.map((q) => q.title + (q.required ? '*' : '')).join(' / ')}\n${r.questions.find((q) => q.type === 'LOCATION')?.location ? '指定签到点：' + JSON.stringify(r.questions.find((q) => q.type === 'LOCATION').location) : '无指定签到点'}` };
      }
      if (a === 'sign') {
        const r = await qun.sign(t, { url: args.url, student: args.student, name: args.name, place: args.place, lat: args.lat, lng: args.lng, mapUrl: args.mapUrl, answers: args.answers || [], dryRun: args.dryRun, force: args.force, amapKey: args.amapKey || C.amapKey });
        if (r.dryRun) return { ok: true, ...r, summary: `🧪 预览（未提交）：${r.title}\n将提交 ${r.payload.catalogs.length} 项，定位：${r.location ? r.location.latitude + ',' + r.location.longitude + '（' + r.location.source + '）' : '无'}` };
        if (r.alreadySigned) return { ok: true, alreadySigned: true, ...r, summary: `ℹ️ 你已签到过（记录 ${r.record?.no ?? ''}，${r.record?.createTime || ''}），未重复提交` };
        const receipt = await makeReceipt({ platform: '群报数', title: r.title, identity: args.student || '', ok: true, address: r.location?.title, coords: r.location ? { latitude: r.location.latitude, longitude: r.location.longitude } : null, record: r.no != null ? `#${r.no} ${r.fid || ''}` : r.fid, message: r.verified ? '服务端回查通过' : '已提交' });
        return { ok: true, ...r, receipt, summary: `✅ 群报数签到成功\n标题：${r.title}\n记录号：${r.no ?? '(接口未返回)'}\n时间：${r.createTime || ''}\n定位：${r.location?.title || ''} ${r.location ? `[${r.location.longitude}, ${r.location.latitude}]` : ''}\n回查：${r.verified ? '通过' : '未确认'}${receipt ? '\n回执图片：' + receipt : ''}` };
      }
      if (a === 'verify') {
        const r = await qun.verify(t, { url: args.url });
        return { ok: true, ...r, summary: `📋 ${r.title}\n${r.signed ? `✅ 已签到，有效记录 ${r.activeCount} 条` : '⚠️ 没有有效记录 —— 尚未签到'}` };
      }
      return { ok: false, summary: '未知 action' };
    },
    { timeoutMs: 120000 },
  );

  // ---------------------------------------------------------------- checkin_ketangpai
  const ktpTool = tool(
    'checkin_ketangpai',
    '课堂派签到。action: doctor/courses/pending/attendance/sign/checkout。sign 不传 attenceId 会巡检所有课程的待签到并逐个签；签入签出会两段处理。GPS 考勤请给教室坐标或用 config 的默认坐标。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['doctor', 'courses', 'pending', 'attendance', 'sign', 'checkout'] },
        courseId: S,
        attenceId: S,
        code: S,
        lat: N,
        lng: N,
        coordsAreWgs84: B,
        requireGpsCoords: B,
        token: S,
        size: N,
      },
      required: ['action'],
    },
    async (args) => {
      const t = args.token || (await getToken(ctx, 'ketangpai'));
      if (!t) return { ok: false, needsToken: true, tokenHow: PLATFORMS.ketangpai.tokenHow, summary: '尚未登录课堂派。请用 checkin_token login_open(ketangpai) 打开浏览器登录后 login_finish 自动读取，或 set 粘贴 token。' };
      const a = args.action;
      if (a === 'doctor') {
        const d = await ktp.doctor(t);
        return { ok: d.checks.every((c) => c.ok), ...d, summary: '课堂派自检：' + d.checks.map((c) => `${c.ok ? '✅' : '⚠️'} ${c.name}：${c.detail}`).join('；') };
      }
      if (a === 'courses') {
        const courses = await ktp.listCourses(t);
        return { ok: true, courses, summary: `📚 ${courses.length} 门课程：\n` + courses.map((c) => `${c.name}（${c.id}）`).join('\n') };
      }
      if (a === 'pending') {
        const pending = await ktp.scanPending(t);
        return { ok: true, pending, summary: pending.length ? `待签到 ${pending.length} 条：\n` + pending.map((p) => `${p.courseName}｜${p.title || p.id}（type ${p.type}）`).join('\n') : '当前没有待签到考勤' };
      }
      if (a === 'attendance') {
        const rows = await ktp.recentAttendance(t, args.courseId, num(args.size) ?? 10);
        return { ok: true, attendance: rows, summary: `最近考勤 ${rows.length} 条：\n` + rows.map((r) => `${r.title || r.id}｜${r.typeName}｜${r.status.label}`).join('\n') };
      }
      const coords = { latitude: num(args.lat) ?? C.latitude, longitude: num(args.lng) ?? C.longitude, coordsAreWgs84: args.coordsAreWgs84 ?? C.coordsAreWgs84 };
      const requireGpsCoords = args.requireGpsCoords ?? C.requireGpsCoords;
      if (a === 'sign') {
        const results = await ktp.signAll(t, { courseId: args.courseId, attenceId: args.attenceId, code: args.code, coords, requireGpsCoords });
        const okCount = results.filter((r) => r.ok).length;
        const needScan = results.filter((r) => r.needScan);
        const receipt = okCount ? await makeReceipt({ platform: '课堂派', title: `签到 ${okCount}/${results.length}`, identity: '', ok: okCount > 0, message: results.map((r) => `${r.courseName || ''} ${r.ok ? '✅' : '❌'}`).join('；') }) : null;
        return { ok: okCount > 0, results, receipt, summary: `课堂派签到：成功 ${okCount}/${results.length}\n` + results.map((r) => `${r.ok ? '✅' : '❌'} ${r.courseName || r.courseId || ''} ${r.type || ''} ${r.verify || r.error || ''}${r.suspicious ? '（坐标异常需注意）' : ''}`).join('\n') + (needScan.length ? `\n⚠️ ${needScan.length} 条扫码考勤需本人微信扫码` : '') };
      }
      if (a === 'checkout') {
        const results = await ktp.checkoutAll(t, { courseId: args.courseId, attenceId: args.attenceId, coords, requireGpsCoords });
        const okCount = results.filter((r) => r.ok).length;
        return { ok: okCount > 0, results, summary: `课堂派签出：成功 ${okCount}/${results.length}\n` + results.map((r) => `${r.ok ? '✅' : '❌'} ${r.courseName || ''} ${r.verify || r.error || ''}`).join('\n') };
      }
      return { ok: false, summary: '未知 action' };
    },
    { timeoutMs: 180000 },
  );

  // ---------------------------------------------------------------- checkin_wps
  const wpsTool = tool(
    'checkin_wps',
    'WPS 表单打卡。action: locate(解析打卡围栏并算出应注入坐标，无需经纬度)/import_cookie(粘贴 Cookie)/status/sign。自动从表单接口取围栏中心，GCJ-02 反算 WGS84 注入，自动续期登录态，成功返回截图。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['locate', 'import_cookie', 'status', 'sign'] },
        formUrl: S,
        name: S,
        studentId: S,
        rangeName: S,
        lat: N,
        lng: N,
        accuracy: N,
        cookiesText: S,
        dryRun: B,
      },
      required: ['action'],
    },
    async (args) => {
      if (args.action === 'locate') {
        const r = await wps.locate(args.formUrl, { rangeName: args.rangeName, fallbackLat: args.lat, fallbackLng: args.lng });
        return { ok: true, ...r, summary: `📍 围栏定位（${r.source}${r.range ? ' / ' + r.range : ''}）\nGCJ-02 中心：${r.centerGcj02 ? r.centerGcj02.latitude + ',' + r.centerGcj02.longitude : '-'}\n注入 WGS84：${r.injectWgs84.latitude}, ${r.injectWgs84.longitude}` };
      }
      if (args.action === 'import_cookie') {
        const existing = (await getGrant(ctx, 'wps')) || [];
        const { jar, updated } = wps.importCookieHeader(existing, args.cookiesText || '');
        await setGrant(ctx, 'wps', jar);
        return { ok: true, updated, total: jar.length, summary: `已导入/更新 ${updated} 条 WPS Cookie，共 ${jar.length} 条` };
      }
      const jar = (await getGrant(ctx, 'wps')) || [];
      if (args.action === 'status') {
        const r = await wps.runSign({ formUrl: args.formUrl, name: args.name || 'x', studentId: args.studentId || 'x', cookies: jar, rangeName: args.rangeName, lat: args.lat, lng: args.lng, statusOnly: true, chromePath: C.chromePath });
        return { ...r, summary: r.code === 3 ? '本轮尚未打卡' : r.code === 0 ? '本轮已打卡' : `状态：${r.message}` };
      }
      if (args.action === 'sign') {
        if (!args.formUrl || !args.name || !args.studentId) return { ok: false, summary: 'sign 需要 formUrl、name、studentId' };
        const r = await wps.runSign({ formUrl: args.formUrl, name: args.name, studentId: args.studentId, cookies: jar, rangeName: args.rangeName, lat: args.lat, lng: args.lng, accuracy: num(args.accuracy) ?? 30, dryRun: args.dryRun, chromePath: C.chromePath });
        if (Array.isArray(r.jar)) await setGrant(ctx, 'wps', r.jar);
        const receipt = r.ok && !args.dryRun ? await makeReceipt({ platform: 'WPS 表单', title: args.formUrl, identity: `${args.name}/${args.studentId}`, ok: true, address: r.address, coords: r.coords, message: r.verified ? '复核通过' : r.message }) : null;
        return { ...r, receipt, summary: `${r.ok ? '✅' : '❌'} WPS 打卡：${r.message}${r.address ? '\n定位：' + r.address : ''}${r.verified ? '\n复核：通过' : ''}${r.screenshot ? '\n截图：' + r.screenshot : ''}${receipt ? '\n回执：' + receipt : ''}` };
      }
      return { ok: false, summary: '未知 action' };
    },
    { timeoutMs: 240000 },
  );

  // ---------------------------------------------------------------- checkin_web
  const webTool = tool(
    'checkin_web',
    '通用网页表单签到。自动识别姓名/学号输入框、注入虚拟定位、点定位按钮、提交并检测成功，返回截图。适合没有开放接口的网页签到；可用 xxxPattern 覆盖识别规则。',
    {
      type: 'object',
      properties: {
        url: S,
        name: S,
        studentId: S,
        place: S,
        lat: N,
        lng: N,
        accuracy: N,
        extras: { type: 'object', additionalProperties: true, description: '额外字段：{标签正则或#selector: 值}' },
        namePattern: S,
        studentPattern: S,
        submitPattern: S,
        locatePattern: S,
        successKeywords: { type: 'array', items: S },
        alreadyKeywords: { type: 'array', items: S },
        dryRun: B,
        headless: B,
        waitMs: N,
      },
      required: ['url'],
    },
    async (args) => {
      const r = await runWebSign({ ...args, chromePath: C.chromePath });
      let receipt = null;
      if (r.ok && !args.dryRun) receipt = await makeReceipt({ platform: '网页表单', title: args.url, identity: [args.name, args.studentId].filter(Boolean).join('/'), ok: true, address: r.address, coords: r.coords, message: r.message });
      return { ...r, receipt, summary: `${r.ok ? '✅' : '❌'} 网页签到：${r.message}${r.address ? '\n定位：' + r.address : ''}${r.screenshot ? '\n截图：' + r.screenshot : ''}${receipt ? '\n回执：' + receipt : ''}` };
    },
    { timeoutMs: 180000 },
  );

  // ---------------------------------------------------------------- checkin_api
  const apiTool = tool(
    'checkin_api',
    '通用 HTTP 接口回放（小程序/App/自定义接口签到的终极手段）。把抓到的签到请求粘进来，经纬度学号用 {{lat}}/{{lng}}/{{student}}/{{ts}} 模板替换；可带 tokenFrom 注入登录态；可配 verify 复查。',
    {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'GET/POST/... 默认 POST' },
        url: S,
        headers: { type: 'object', additionalProperties: true },
        body: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }], description: '字符串或对象；字符串支持 {{lat}} 等模板' },
        tokenFrom: { type: 'string', enum: ['qun100', 'ketangpai', 'wps'] },
        tokenHeader: { type: 'string' },
        lat: N,
        lng: N,
        coordsAreWgs84: B,
        student: S,
        name: S,
        address: S,
        vars: { type: 'object', additionalProperties: true },
        verify: { type: 'object', additionalProperties: true, description: '{url,method,body,headers,successContains,successPath}' },
        timeoutMs: N,
      },
      required: ['url'],
    },
    async (args) => {
      const r = await replay(ctx, { ...args, timeoutMs: num(args.timeoutMs) ?? 20000 });
      const okish = r.ok && (!r.verify || r.verify.passed !== false);
      return {
        ok: okish,
        ...r,
        summary: `接口回放 ${r.request.method} ${r.request.url}\n状态：HTTP ${r.status}\n响应：${renderText(r.json ?? r.text).slice(0, 1200)}${r.verify ? `\n复查：${r.verify.passed === true ? '通过' : r.verify.passed === false ? '未通过' : 'status ' + r.verify.status}` : ''}`,
      };
    },
  );

  // ---------------------------------------------------------------- checkin_sign (unified)
  const signTool = tool(
    'checkin_sign',
    '一键签到分发：platform=qun100|ketangpai|wps。缺登录态时返回 needsToken 与获取方式；否则直接走对应平台签到并返回结果摘要。',
    {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['qun100', 'ketangpai', 'wps'] },
        url: S,
        formUrl: S,
        student: S,
        name: S,
        studentId: S,
        place: S,
        lat: N,
        lng: N,
        code: S,
        dryRun: B,
      },
      required: ['platform'],
    },
    async (args) => {
      const p = args.platform;
      const dryRun = args.dryRun === true;
      if (p === 'qun100') {
        const t = await getToken(ctx, 'qun100');
        if (!t) return { ok: false, needsToken: true, tokenHow: PLATFORMS.qun100.tokenHow, summary: '缺少群报数登录态：请 checkin_qun100 login_qr 扫码。' };
        const r = await qun.sign(t, { url: args.url || args.formUrl, student: args.student, name: args.name, place: args.place, lat: args.lat, lng: args.lng, dryRun, amapKey: C.amapKey });
        return { ok: !!(r.submitted || r.alreadySigned || r.dryRun), kind: 'qun100', ...r, summary: r.alreadySigned ? 'ℹ️ 群报数已签到过' : r.dryRun ? '🧪 群报数预览：' + renderText(r).slice(0, 500) : `✅ 群报数签到成功，记录 ${r.no ?? ''}` };
      }
      if (p === 'ketangpai') {
        const t = await getToken(ctx, 'ketangpai');
        if (!t) return { ok: false, needsToken: true, tokenHow: PLATFORMS.ketangpai.tokenHow, summary: '缺少课堂派登录态：请 checkin_token login_open(ketangpai)。' };
        const results = await ktp.signAll(t, { courseId: args.url || undefined, code: args.code, coords: { latitude: num(args.lat) ?? C.latitude, longitude: num(args.lng) ?? C.longitude, coordsAreWgs84: C.coordsAreWgs84 }, requireGpsCoords: C.requireGpsCoords });
        const okCount = results.filter((r) => r.ok).length;
        return { ok: okCount > 0, kind: 'ketangpai', results, summary: `课堂派签到：成功 ${okCount}/${results.length}` };
      }
      if (p === 'wps') {
        const jar = (await getGrant(ctx, 'wps')) || [];
        if (!jar.length) return { ok: false, needsToken: true, tokenHow: PLATFORMS.wps.tokenHow, summary: '缺少 WPS 登录态：请 checkin_token login_open(wps)。' };
        const r = await wps.runSign({ formUrl: args.formUrl || args.url, name: args.name, studentId: args.studentId || args.student, cookies: jar, lat: args.lat, lng: args.lng, dryRun, chromePath: C.chromePath });
        if (Array.isArray(r.jar)) await setGrant(ctx, 'wps', r.jar);
        return { ok: r.ok, kind: 'wps', ...r, summary: `${r.ok ? '✅' : '❌'} WPS：${r.message}${r.screenshot ? '\n截图：' + r.screenshot : ''}` };
      }
      return { ok: false, summary: '未知 platform' };
    },
    { timeoutMs: 240000 },
  );

  return { tools: [guide, token, geoTool, browser, qunTool, ktpTool, wpsTool, webTool, apiTool, signTool], systemPrompt: buildSystemPrompt() };
}
