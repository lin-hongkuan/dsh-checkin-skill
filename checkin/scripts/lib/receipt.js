/**
 * Render a "check-in receipt" PNG (a friendly confirmation card) so the user can see
 * the result at a glance. Best-effort: returns null when Chrome is unavailable.
 */
import { launchChrome, connectFirstPage, screenshot, findChrome } from './cdp.js';
import { sleep } from './util.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function buildReceiptHtml(data = {}) {
  const ok = data.ok !== false;
  const accent = ok ? '#16a34a' : '#dc2626';
  const rows = [
    ['平台', data.platform],
    ['项目', data.title],
    ['身份', data.identity],
    ['地点', data.address || (data.coords ? `${data.coords.latitude}, ${data.coords.longitude}` : '')],
    ['时间', data.time || new Date().toLocaleString('zh-CN', { hour12: false })],
    ['记录', data.record],
    ['说明', data.message],
  ].filter(([, v]) => v != null && v !== '');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;box-sizing:border-box;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif}
    body{width:420px;padding:28px;background:#f8fafc}
    .card{background:#fff;border-radius:20px;padding:28px;box-shadow:0 10px 30px rgba(15,23,42,.12)}
    .badge{width:64px;height:64px;border-radius:50%;background:${accent}1a;display:flex;align-items:center;justify-content:center;margin:0 auto 14px}
    .mark{font-size:34px;color:${accent};line-height:1}
    h1{font-size:20px;text-align:center;color:#0f172a;margin-bottom:4px}
    .sub{text-align:center;color:#64748b;font-size:13px;margin-bottom:20px}
    .row{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px dashed #e2e8f0;font-size:14px}
    .row:last-child{border-bottom:none}
    .k{color:#94a3b8;flex:none}
    .v{color:#0f172a;text-align:right;word-break:break-all}
    .foot{margin-top:18px;text-align:center;color:#94a3b8;font-size:11px}
  </style></head><body><div class="card">
    <div class="badge"><div class="mark">${ok ? '✓' : '!'}</div></div>
    <h1>${ok ? '签到成功' : '签到结果'}</h1>
    <div class="sub">Check-in copilot · 自动签到回执</div>
    ${rows.map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}
    <div class="foot">生成于 ${esc(new Date().toLocaleString('zh-CN', { hour12: false }))}</div>
  </div></body></html>`;
}

export async function renderReceipt(data, { chromePath } = {}) {
  if (!findChrome(chromePath)) return null;
  let chrome;
  try {
    chrome = await launchChrome({ headless: true, chromePath });
    const { cdp } = await connectFirstPage(chrome);
    await cdp.send('Page.enable');
    const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(buildReceiptHtml(data));
    await cdp.send('Page.navigate', { url });
    await sleep(600);
    const file = await screenshot(cdp);
    cdp.close();
    return file;
  } catch {
    return null;
  } finally {
    try {
      chrome?.cleanup();
    } catch {
      /* ignore */
    }
  }
}
