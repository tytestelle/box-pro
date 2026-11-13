// src/main/LiveSubscriptionManager.ts
// 网络直播订阅源：下载到本地 → 走「本地文件导入」链路注册到 lives → CRUD + 排序。
//
// 数据文件：
//   <userData>/live-subscriptions/index.json   元数据
//   <userData>/live-subscriptions/files/<id>.<ext>   下载的源文件
//
// ★★ 2026-11-13（用户要求）：启动即校验 + 更新后广播 payload ★★
//   - 校验逻辑：拉远端文本 → 与本地缓存逐字节对比 → 一致跳过 / 有变化重新导入；
//   - 失败：保留旧文件、保留 lives 条目，只记 lastError（用户要求「源不存在保留旧的继续播放」）；
//   - 广播：notifyLiveSubscriptionsChanged(payload) 带 updatedIds / failedIds / reason，
//     渲染层据此做精细 diff（名字变了只刷新 UI、URL 变了重播、频道没了继续播）。
import { app, ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  LiveSubscription,
  LiveSubscriptionRefreshResult,
  UserConfig,
} from '../shared/types';
import { LOCAL_PROXY_BASE } from '../shared/constants';
// ★ 2026-11-13 修复 TS2307：本文件在 src/main/ 下，到 src/engine 只需往上一级（此前多写了一级 '..'）。
import { localLiveUrl } from '../engine/live/localLive';
import { UserConfigManager } from './store/UserConfigManager';

// =========================================================================
// 通道名
// =========================================================================
export const LIVE_SUB_CHANNELS = {
  LIST: 'live:subscription:list',
  ADD: 'live:subscription:add',
  REMOVE: 'live:subscription:remove',
  UPDATE: 'live:subscription:update',
  TOGGLE: 'live:subscription:toggle',
  MOVE: 'live:subscription:move',
  REFRESH_ALL: 'live:subscription:refreshAll',
} as const;

// ★ 2026-10-13：本地源管理（用户手动导入的本地 TXT/M3U；非网络订阅源）
export const LIVE_LOCAL_CHANNELS = {
  LIST: 'live:local:list',
  REMOVE: 'live:local:remove',
} as const;

export const LIVE_SUB_CHANGED_CHANNEL = 'live:subscriptions-changed';

// ★ 2026-11-13（用户要求）：广播带 payload，渲染层据此做精细 diff
export interface LiveSubChangedPayload {
  /** 本次是否有订阅源内容变化并重新导入（true 才需要 diff） */
  updated: boolean;
  /** 更新成功的订阅源 id（内容有变化并重新导入的） */
  updatedIds: string[];
  /** 更新失败的订阅源 id（保留旧文件继续使用） */
  failedIds: string[];
  /** 触发原因：startup（启动校验）/ manual（手动刷新）/ crud（增删改） */
  reason: 'startup' | 'manual' | 'crud';
}

const EMPTY_PAYLOAD: LiveSubChangedPayload = {
  updated: false,
  updatedIds: [],
  failedIds: [],
  reason: 'crud',
};

export function notifyLiveSubscriptionsChanged(payload?: LiveSubChangedPayload): void {
  const p = payload ?? EMPTY_PAYLOAD;
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send(LIVE_SUB_CHANGED_CHANNEL, p);
    } catch { /* ignore */ }
  }
}

// =========================================================================
// 可注入的「本地文件导入」函数
// =========================================================================
export interface LiveImporterResult {
  ok: boolean;
  name?: string;
  index?: number;
  replaced?: boolean;
  total?: number;
  api?: string;
  error?: string;
}
export type LiveImporter = (
  srcPath: string,
  opts: { customName?: string; stableFileName?: string },
) => LiveImporterResult;

let liveImporter: LiveImporter | null = null;
export function bindLiveImporter(fn: LiveImporter): void {
  liveImporter = fn;
}

// =========================================================================
// 路径
// =========================================================================
function rootDir(): string { return path.join(app.getPath('userData'), 'live-subscriptions'); }
function indexFile(): string { return path.join(rootDir(), 'index.json'); }
function filesDir(): string { return path.join(rootDir(), 'files'); }
function userConfigPath(): string { return path.join(app.getPath('userData'), 'user-config.json'); }
function localLiveDir(): string { return path.join(app.getPath('userData'), LOCAL_LIVE_SUBDIR); }

async function ensureDirs(): Promise<void> {
  await fs.mkdir(rootDir(), { recursive: true });
  await fs.mkdir(filesDir(), { recursive: true });
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, file);
}

// =========================================================================
// 订阅源元数据读写
// =========================================================================
export async function listSubscriptions(): Promise<LiveSubscription[]> {
  await ensureDirs();
  try {
    const raw = await fs.readFile(indexFile(), 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.url === 'string')
      .map((x) => ({
        id: String(x.id),
        name: String(x.name || '').trim() || '未命名订阅',
        url: String(x.url || '').trim(),
        enabled: x.enabled !== false,
        lastUpdated: typeof x.lastUpdated === 'string' ? x.lastUpdated : undefined,
        lastError: typeof x.lastError === 'string' ? x.lastError : undefined,
        localFile: typeof x.localFile === 'string' ? x.localFile : undefined,
      }));
  } catch {
    return [];
  }
}

async function saveSubscriptions(subs: LiveSubscription[]): Promise<void> {
  await ensureDirs();
  await atomicWrite(indexFile(), JSON.stringify(subs, null, 2));
}

// =========================================================================
// UserConfig 读写（走内存，落盘由 UserConfigManager 内部处理）
// =========================================================================
async function readUserConfig(): Promise<UserConfig | null> {
  const uc = UserConfigManager.current;
  if (uc) {
    try { return uc.snapshot(); }
    catch (e) { console.warn('[LiveSub] 读取内存配置失败，回退磁盘：', e); }
  }
  try {
    const raw = await fs.readFile(userConfigPath(), 'utf-8');
    return JSON.parse(raw) as UserConfig;
  } catch {
    return null;
  }
}

async function writeUserConfig(cfg: UserConfig): Promise<void> {
  const uc = UserConfigManager.current;
  if (uc) {
    try { uc.restore(cfg); return; }
    catch (e) { console.warn('[LiveSub] 写入内存配置失败，回退磁盘：', e); }
  }
  await atomicWrite(userConfigPath(), JSON.stringify(cfg, null, 2));
}

// =========================================================================
// 订阅源在 lives 里的稳定标识
// =========================================================================
const SUB_BEAN_PREFIX = '【订阅】';
const LOCAL_LIVE_SUBDIR = 'local-live';
const LOCAL_LIVE_API_PREFIX = `${LOCAL_PROXY_BASE}/file/local-live/`;

function extForUrl(url: string): string {
  const u = url.toLowerCase().split('?')[0].split('#')[0];
  if (u.endsWith('.txt')) return 'txt';
  if (u.endsWith('.json')) return 'json';
  return 'm3u';
}

function stableFileNameOf(subId: string, url: string): string {
  return `sub-${subId}.${extForUrl(url)}`;
}

function apiOf(subId: string, url: string): string {
  return localLiveUrl(LOCAL_PROXY_BASE, stableFileNameOf(subId, url));
}

function isLocalLiveApi(api: string): boolean {
  return typeof api === 'string' && api.startsWith(LOCAL_LIVE_API_PREFIX);
}

function isSubscriptionLocalFileName(fileName: string): boolean {
  return fileName.startsWith('sub-');
}

async function removeSubFromLives(sub: LiveSubscription): Promise<void> {
  const uc = UserConfigManager.current;
  if (!uc) {
    console.warn('[LiveSub] UserConfigManager.current 未就绪，无法移除 lives');
    return;
  }
  const api = apiOf(sub.id, sub.url);
  const ok = uc.removeLiveByApi(api);
  if (ok) console.info(`[LiveSub] 已从 lives 移除：${api}`);
}

async function downloadToCache(sub: LiveSubscription): Promise<string> {
  const text = await fetchText(sub.url);
  if (!text || !text.trim()) throw new Error('订阅内容为空');
  await ensureDirs();
  const ext = extForUrl(sub.url);
  const file = path.join(filesDir(), `${sub.id}.${ext}`);
  await atomicWrite(file, text);
  return file;
}

async function deleteLocalFile(localFile?: string): Promise<void> {
  if (!localFile) return;
  try { await fs.unlink(localFile); } catch { /* ignore */ }
}

async function fileExists(p?: string): Promise<boolean> {
  if (!p) return false;
  try { await fs.access(p); return true; } catch { return false; }
}

// =========================================================================
// 网络下载（★ 超时 120 秒；GitHub raw 自动加镜像回退）
// =========================================================================
const FETCH_TIMEOUT_MS = 120_000;

function buildFetchCandidates(url: string): string[] {
  const list: string[] = [url];
  try {
    const u = new URL(url);
    const isGithubRaw =
      u.hostname === 'raw.githubusercontent.com' ||
      u.hostname === 'gist.githubusercontent.com' ||
      (u.hostname === 'github.com' && /\/raw\//.test(u.pathname));
    if (isGithubRaw) {
      list.push(`https://ghproxy.net/${url}`);
      list.push(`https://gh-proxy.com/${url}`);
    }
  } catch { /* ignore */ }
  return list;
}

async function fetchOnce(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Win-Box/1.0 (+live-subscription)',
        Accept: '*/*',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
    const buf = await res.arrayBuffer();

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const m = ct.match(/charset=([\w-]+)/i);
    const cs = (m?.[1] || '').toLowerCase();
    const decode = (c: string): string | null => {
      try { return new TextDecoder(c, { fatal: false }).decode(buf); } catch { return null; }
    };
    if (cs === 'gbk' || cs === 'gb2312' || cs === 'gb18030') {
      return decode('gbk') ?? decode('utf-8') ?? '';
    }
    if (cs && cs !== 'utf-8' && cs !== 'utf8') {
      return decode(cs) ?? decode('utf-8') ?? '';
    }
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.length > 0) {
      const bad = (text.match(/\uFFFD/g) || []).length;
      if (bad / text.length > 0.05) {
        const gbk = decode('gbk');
        if (gbk && gbk.length) text = gbk;
      }
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string): Promise<string> {
  const candidates = buildFetchCandidates(url);
  let lastErr: unknown = null;
  for (const c of candidates) {
    try {
      return await fetchOnce(c);
    } catch (e) {
      lastErr = e;
      console.warn(`[LiveSub] fetch 失败 ${c}：${(e as Error)?.message || e}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// =========================================================================
// CRUD
// =========================================================================
export async function addSubscription(name: string, url: string): Promise<LiveSubscription> {
  if (!liveImporter) throw new Error('直播导入器未就绪（主进程未调用 bindLiveImporter）');
  const n = (name || '').trim();
  const u = (url || '').trim();
  if (!n) throw new Error('订阅名称不能为空');
  if (!/^https?:\/\//i.test(u)) throw new Error('订阅链接必须以 http:// 或 https:// 开头');

  const sub: LiveSubscription = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: n,
    url: u,
    enabled: true,
  };

  try {
    sub.localFile = await downloadToCache(sub);
    sub.lastUpdated = new Date().toISOString();
  } catch (e) {
    sub.lastError = (e as Error).message;
  }

  if (sub.localFile) {
    const r = liveImporter(sub.localFile, {
      customName: `${SUB_BEAN_PREFIX}${sub.name}`,
      stableFileName: stableFileNameOf(sub.id, sub.url),
    });
    if (!r.ok) sub.lastError = r.error || '注册失败';
  }

  const subs = await listSubscriptions();
  subs.push(sub);
  await saveSubscriptions(subs);

  notifyLiveSubscriptionsChanged(EMPTY_PAYLOAD);
  return sub;
}

export async function removeSubscription(id: string): Promise<void> {
  const subs = await listSubscriptions();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const sub = subs[idx];

  try { await removeSubFromLives(sub); } catch (e) { console.warn('[LiveSub] 移除 lives 失败：', e); }
  await deleteLocalFile(sub.localFile);
  try {
    await fs.rm(path.join(localLiveDir(), stableFileNameOf(sub.id, sub.url)), { force: true });
  } catch { /* ignore */ }
  subs.splice(idx, 1);
  await saveSubscriptions(subs);

  notifyLiveSubscriptionsChanged(EMPTY_PAYLOAD);
}

export async function updateSubscription(
  id: string,
  patch: Partial<Pick<LiveSubscription, 'name' | 'url' | 'enabled'>>,
): Promise<LiveSubscription | null> {
  if (!liveImporter) throw new Error('直播导入器未就绪（主进程未调用 bindLiveImporter）');
  const subs = await listSubscriptions();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  const old = subs[idx];
  const next: LiveSubscription = { ...old };

  if (typeof patch.name === 'string') {
    const n = patch.name.trim();
    if (!n) throw new Error('名称不能为空');
    next.name = n;
  }
  if (typeof patch.url === 'string') {
    const u = patch.url.trim();
    if (!/^https?:\/\//i.test(u)) throw new Error('订阅链接必须以 http:// 或 https:// 开头');
    next.url = u;
  }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;

  const urlChanged = old.url !== next.url;
  const enabledChanged = old.enabled !== next.enabled;
  const nameChanged = old.name !== next.name;

  if (!next.enabled) {
    if (old.enabled) {
      try { await removeSubFromLives(old); } catch { /* ignore */ }
    }
    if (urlChanged) {
      await deleteLocalFile(old.localFile);
      try { await fs.rm(path.join(localLiveDir(), stableFileNameOf(old.id, old.url)), { force: true }); } catch { /* ignore */ }
      next.localFile = undefined;
    }
    subs[idx] = next;
    await saveSubscriptions(subs);
    notifyLiveSubscriptionsChanged(EMPTY_PAYLOAD);
    return next;
  }

  const needDownload = urlChanged || !old.localFile || !(await fileExists(old.localFile));

  if (needDownload) {
    if (urlChanged && old.localFile) {
      await deleteLocalFile(old.localFile);
      next.localFile = undefined;
    }
    try {
      next.localFile = await downloadToCache(next);
      next.lastUpdated = new Date().toISOString();
      next.lastError = undefined;
    } catch (e) {
      next.lastError = (e as Error).message;
    }
  }

  if (next.localFile) {
    const r = liveImporter(next.localFile, {
      customName: `${SUB_BEAN_PREFIX}${next.name}`,
      stableFileName: stableFileNameOf(next.id, next.url),
    });
    if (!r.ok) {
      next.lastError = r.error || '注册失败';
    } else if (nameChanged || enabledChanged || urlChanged) {
      next.lastError = undefined;
    }
  }

  subs[idx] = next;
  await saveSubscriptions(subs);
  notifyLiveSubscriptionsChanged(EMPTY_PAYLOAD);
  return next;
}

export async function moveSubscription(
  id: string,
  direction: 'up' | 'down' | 'top' | 'bottom',
): Promise<LiveSubscription[]> {
  const subs = await listSubscriptions();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx < 0) return subs;

  let target = idx;
  if (direction === 'up') target = Math.max(0, idx - 1);
  else if (direction === 'down') target = Math.min(subs.length - 1, idx + 1);
  else if (direction === 'top') target = 0;
  else if (direction === 'bottom') target = subs.length - 1;

  if (target === idx) return subs;

  const [item] = subs.splice(idx, 1);
  subs.splice(target, 0, item);
  await saveSubscriptions(subs);

  notifyLiveSubscriptionsChanged(EMPTY_PAYLOAD);
  return subs;
}

// =========================================================================
// 刷新（手动触发；下载最新内容 → 走本地导入覆盖）
// =========================================================================
export async function refreshAllSubscriptions(): Promise<LiveSubscriptionRefreshResult[]> {
  const results: LiveSubscriptionRefreshResult[] = [];
  if (!liveImporter) return results;
  const subs = await listSubscriptions();
  let dirty = false;
  const updatedIds: string[] = [];
  const failedIds: string[] = [];

  for (const sub of subs) {
    if (!sub.enabled) {
      results.push({ id: sub.id, name: sub.name, ok: false, error: '已停用' });
      continue;
    }
    try {
      sub.localFile = await downloadToCache(sub);
      const r = liveImporter(sub.localFile, {
        customName: `${SUB_BEAN_PREFIX}${sub.name}`,
        stableFileName: stableFileNameOf(sub.id, sub.url),
      });
      if (!r.ok) throw new Error(r.error || '重新导入失败');
      sub.lastUpdated = new Date().toISOString();
      sub.lastError = undefined;
      results.push({ id: sub.id, name: sub.name, ok: true, lastUpdated: sub.lastUpdated });
      updatedIds.push(sub.id);
      dirty = true;
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      sub.lastError = msg;
      failedIds.push(sub.id);
      results.push({ id: sub.id, name: sub.name, ok: false, error: msg });
      dirty = true;
    }
  }

  if (dirty) {
    try { await saveSubscriptions(subs); } catch { /* ignore */ }
  }
  notifyLiveSubscriptionsChanged({
    updated: updatedIds.length > 0,
    updatedIds,
    failedIds,
    reason: 'manual',
  });
  return results;
}

// =========================================================================
// ★ 启动时自动检查更新 —— 有变化才重新导入；无变化则保留原样。
// =========================================================================
export interface CheckUpdateSummary {
  updated: number;
  skipped: number;
  failed: number;
}

/**
 * 遍历所有启用的订阅源：
 *   1) 拉取远端最新内容；
 *   2) 与本地缓存逐字节对比；
 *   3) **一致 → 跳过**（不动 lives、不动本地文件）；
 *   4) **有变化 → 覆盖本地文件 + 走本地导入链路重新注册**（replaced=true 覆盖同条目）；
 *   5) 失败 → 记录 lastError，**不动本地文件**（用户要求「源不存在保留旧的继续播放」）。
 *   最后按 updatedIds / failedIds 广播，渲染层做精细 diff。
 */
export async function checkAndUpdateSubscriptions(): Promise<CheckUpdateSummary> {
  const summary: CheckUpdateSummary = { updated: 0, skipped: 0, failed: 0 };
  if (!liveImporter) return summary;

  const subs = await listSubscriptions();
  let dirty = false;
  const updatedIds: string[] = [];
  const failedIds: string[] = [];

  for (const sub of subs) {
    if (!sub.enabled) { summary.skipped++; continue; }
    try {
      const remote = await fetchText(sub.url);
      if (!remote || !remote.trim()) throw new Error('订阅内容为空');

      // 与本地缓存对比：内容一致 → 跳过（不重新导入）
      let local: string | null = null;
      if (sub.localFile) {
        try { local = await fs.readFile(sub.localFile, 'utf-8'); } catch { local = null; }
      }
      if (local !== null && local === remote) { summary.skipped++; continue; }

      // 有变化 → 覆盖本地文件 + 走本地导入覆盖 lives 里的对应线路
      await ensureDirs();
      const ext = extForUrl(sub.url);
      const cacheFile = path.join(filesDir(), `${sub.id}.${ext}`);
      await atomicWrite(cacheFile, remote);
      const r = liveImporter(cacheFile, {
        customName: `${SUB_BEAN_PREFIX}${sub.name}`,
        stableFileName: stableFileNameOf(sub.id, sub.url),
      });
      if (!r.ok) throw new Error(r.error || '重新导入失败');

      sub.localFile = cacheFile;
      sub.lastUpdated = new Date().toISOString();
      sub.lastError = undefined;
      summary.updated++;
      updatedIds.push(sub.id);
      dirty = true;
      console.info(`[LiveSub] 订阅「${sub.name}」有更新，已重新导入到 lives`);
    } catch (e) {
      // ★ 用户要求：源不存在 / 网络失败 → 保留旧文件、保留 lives 条目，只记 lastError
      sub.lastError = (e as Error)?.message || String(e);
      summary.failed++;
      failedIds.push(sub.id);
      dirty = true;
      console.warn(`[LiveSub] 订阅「${sub.name}」检查更新失败（保留旧文件）：${sub.lastError}`);
    }
  }

  if (dirty) {
    try { await saveSubscriptions(subs); } catch { /* ignore */ }
  }
  // ★ 只有真的发生了变化（成功或失败）才广播，避免无意义刷新
  if (updatedIds.length > 0 || failedIds.length > 0) {
    notifyLiveSubscriptionsChanged({
      updated: updatedIds.length > 0,
      updatedIds,
      failedIds,
      reason: 'startup',
    });
  }
  return summary;
}

// =========================================================================
// 本地源管理（用户手动导入的本地 TXT/M3U；非网络订阅源）
// =========================================================================
export interface LocalLiveSource {
  name: string;
  api: string;
  fileName: string;
  fileExists: boolean;
}

export async function listLocalLiveSources(): Promise<LocalLiveSource[]> {
  const uc = UserConfigManager.current;
  if (!uc) return [];
  const cfg = uc.snapshot();
  const out: LocalLiveSource[] = [];
  for (const l of cfg.lives || []) {
    const api = String(l.url || '').trim();
    if (!isLocalLiveApi(api)) continue;
    const fileName = api.slice(LOCAL_LIVE_API_PREFIX.length);
    if (!fileName) continue;
    if (isSubscriptionLocalFileName(fileName)) continue;
    out.push({
      name: String(l.name || '').trim() || fileName,
      api,
      fileName,
      fileExists: await fileExists(path.join(localLiveDir(), fileName)),
    });
  }
  return out;
}

export async function removeLocalLiveSource(api: string): Promise<boolean> {
  const uc = UserConfigManager.current;
  if (!uc) throw new Error('配置管理器未就绪');
  const target = String(api || '').trim();
  if (!isLocalLiveApi(target)) throw new Error('不是本地直播源');
  const fileName = target.slice(LOCAL_LIVE_API_PREFIX.length);
  if (!fileName) throw new Error('本地文件名解析失败');
  if (isSubscriptionLocalFileName(fileName)) {
    throw new Error('该源由网络订阅源管理，请在「网络订阅源」列表中删除');
  }

  const removed = uc.removeLiveByApi(target);
  if (removed) {
    try {
      await fs.rm(path.join(localLiveDir(), fileName), { force: true });
    } catch (e) {
      console.warn('[LiveSub] 删除本地文件失败：', e);
    }
    notifyLiveSubscriptionsChanged(EMPTY_PAYLOAD);
    console.info(`[LiveSub] 已删除本地源：${fileName}`);
  }
  return removed;
}

// =========================================================================
// IPC 注册
// =========================================================================
export function registerLiveSubscriptionIpc(): void {
  ipcMain.handle(LIVE_SUB_CHANNELS.LIST, async () => listSubscriptions());
  ipcMain.handle(LIVE_SUB_CHANNELS.ADD, async (_e, name: string, url: string) => addSubscription(name, url));
  ipcMain.handle(LIVE_SUB_CHANNELS.REMOVE, async (_e, id: string) => { await removeSubscription(id); return true; });
  ipcMain.handle(LIVE_SUB_CHANNELS.UPDATE, async (_e, id: string, patch: any) => updateSubscription(id, patch || {}));
  ipcMain.handle(LIVE_SUB_CHANNELS.TOGGLE, async (_e, id: string, enabled: boolean) => updateSubscription(id, { enabled: !!enabled }));
  ipcMain.handle(LIVE_SUB_CHANNELS.MOVE, async (_e, id: string, dir: 'up' | 'down' | 'top' | 'bottom') => moveSubscription(id, dir));
  ipcMain.handle(LIVE_SUB_CHANNELS.REFRESH_ALL, async () => refreshAllSubscriptions());

  ipcMain.handle(LIVE_LOCAL_CHANNELS.LIST, async () => listLocalLiveSources());
  ipcMain.handle(LIVE_LOCAL_CHANNELS.REMOVE, async (_e, api: string) => removeLocalLiveSource(String(api || '')));
}
