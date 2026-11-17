/**
 * File-backed token / cookie / pending-login store for the checkin skill.
 * Skills run outside the Harness service graph, so secrets live in a small JSON
 * file under the user's .dsh directory (override with CHECKIN_STATE_DIR).
 * API-compatible with the plugin's ctx.credentials store; the ctx argument is ignored.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = process.env.CHECKIN_STATE_DIR || path.join(os.homedir(), '.dsh', 'checkin');
const FILE = path.join(DIR, 'state.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}
function writeAll(obj) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    /* ignore write errors */
  }
}
const key = (kind, platform) => `${kind}:${platform}`;

export function persistenceAvailable() {
  return true;
}
export async function getToken(_ctx, platform) {
  return readAll()[key('token', platform)];
}
export async function setToken(_ctx, platform, value) {
  const all = readAll();
  all[key('token', platform)] = String(value);
  writeAll(all);
}
export async function clearToken(_ctx, platform) {
  const all = readAll();
  delete all[key('token', platform)];
  writeAll(all);
}
export async function getGrant(_ctx, name) {
  return readAll()[key('grant', name)];
}
export async function setGrant(_ctx, name, payload) {
  const all = readAll();
  all[key('grant', name)] = payload;
  writeAll(all);
}
export async function clearGrant(_ctx, name) {
  const all = readAll();
  delete all[key('grant', name)];
  writeAll(all);
}
export function mask(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 4) + '…' + s.slice(-4);
}
export function stateFile() {
  return FILE;
}
