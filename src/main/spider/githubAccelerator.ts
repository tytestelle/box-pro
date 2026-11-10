// src/main/spider/githubAccelerator.ts
// ★ 2026-11-10：GitHub 加速下载器 —— 移植自 main.js（测速 + 换线 + 速度门限）。
//   py 源在 GitHub raw / gist / objects.githubusercontent 等墙外地址时，
//   自动用加速前缀（GH_ACCEL_PREFIXES）测速排名，按顺序尝试，速度不够自动换线。
//   非 GitHub 地址直接单线路下载；调用方负责 UA / Referer / 代理等业务参数。
import { request as undiciRequest, type Dispatcher } from 'undici';

// ===== GitHub 加速前缀（来自 main.js，保持原样） =====
export const GH_ACCEL_PREFIXES: string[] = [ ... ];

// ===== 测速常量 =====
const ACCEL_PROBE_LIMIT = 56;
const ACCEL_PROBE_CONCURRENCY = 10;
const ACCEL_PROBE_BYTES = 96 * 1024;
const ACCEL_PROBE_MS = 2200;
const ACCEL_FINALISTS = 3;
const PROBE_SMALL = { bytes: ACCEL_PROBE_BYTES, ms: ACCEL_PROBE_MS, headersTimeout: 2500 };
const PROBE_BIG = { bytes: 1536 * 1024, ms: 3000, headersTimeout: 3000 };
const SPEED_MIN_BYTES = 64 * 1024;
const UA = 'Win-Box-Updater';
const MIN_DOWNLOAD_BPS = 1024 * 1024;
const SPEED_WINDOW_MS = 10000;
const MAX_RETESTS = 3;
const MAX_REDIRECTS = 8;

export interface AccelOptions {
  dispatcher?: Dispatcher;
  log?: (msg: string) => void;
  /** 单线路下载速度门限（默认 1MB/s）；加速下载时对每条线路生效 */
  minSpeedBps?: number;
  speedWindowMs?: number;
}

interface ProbeSample { url: string; bytes: number; ms: number; ok: boolean; ttfb?: number; }

export function isGitHubUrl(url: string): boolean {
  const u = (url || '').trim();
  if (!u) return false;
  return /^https?:\/\/(www\.)?github\.com\//i.test(u)
    || /githubusercontent\.com/i.test(u)
    || /^https?:\/\/(codeload\.)?github\.com\//i.test(u)
    || /^https?:\/\/github\.com\/.*\/releases\//i.test(u);
}

export function buildAccelUrls(url: string, prefixes: string[] = GH_ACCEL_PREFIXES): string[] {
  const raw = (url || '').trim();
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of prefixes) {
    const pre = p.endsWith('/') ? p : p + '/';
    const u = pre + raw;
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  if (!seen.has(raw)) out.push(raw);
  return out;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function sampleBps(s: ProbeSample): number {
  if (!s.ok || s.ms <= 0 || s.bytes <= 0) return 0;
  const ttfb = Math.max(0, Number(s.ttfb) || 0);
  const steadyMs = s.ms - ttfb;
  const useMs = steadyMs >= 100 ? steadyMs : s.ms;
  return Math.round((s.bytes * 1000) / useMs);
}

function rankBySpeed(samples: ProbeSample[], minBytes = 0): string[] {
  const good = samples
    .filter((s) => s.ok && s.bytes >= minBytes)
    .sort((a, b) => sampleBps(b) - sampleBps(a))
    .map((s) => s.url);
  const rest = samples.filter((s) => !(s.ok && s.bytes >= minBytes)).map((s) => s.url);
  return [...good, ...rest];
}

async function probeSpeed(url: string, opts: { bytes: number; ms: number; headersTimeout: number }, dispatcher?: Dispatcher): Promise<ProbeSample> {
  const ac = new AbortController();
  const t0 = Date.now();
  let first = 0;
  let bytes = 0;
  let ok = false;
  try {
    const res = await undiciRequest(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Range: `bytes=0-${opts.bytes - 1}` },
      headersTimeout: opts.headersTimeout,
      bodyTimeout: opts.ms + 500,
      signal: ac.signal,
      dispatcher,
    });
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      await res.body.dump();
      return { url, bytes: 0, ms: Date.now() - t0, ok: false };
    }
    ok = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { ac.abort(); resolve(); }, opts.ms);
      res.body.on('data', (c: Buffer) => {
        if (!first) first = Date.now();
        bytes += c.length;
        if (bytes >= opts.bytes) { clearTimeout(timer); ac.abort(); resolve(); }
      });
      res.body.on('end', () => { clearTimeout(timer); resolve(); });
      res.body.on('error', () => { clearTimeout(timer); resolve(); });
    });
  } catch {
    return { url, bytes, ms: Date.now() - t0, ok: ok && bytes > 0, ttfb: first ? first - t0 : 0 };
  }
  return { url, bytes, ms: Date.now() - t0, ok, ttfb: first ? first - t0 : 0 };
}

async function collectSamples(urls: string[], opts: { bytes: number; ms: number; headersTimeout: number }, concurrency: number, dispatcher?: Dispatcher): Promise<ProbeSample[]> {
  const got: Array<ProbeSample | null> = urls.map(() => null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) {
      const i = cursor++;
      try { got[i] = await probeSpeed(urls[i], opts, dispatcher); }
      catch { got[i] = { url: urls[i], bytes: 0, ms: 0, ok: false }; }
    }
  };
  await Promise.race([
    Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, urls.length)) }, worker)),
    new Promise<void>((r) => setTimeout(r, opts.ms + 800)),
  ]);
  return urls.map((u, i) => got[i] ?? { url: u, bytes: 0, ms: 0, ok: false });
}

async function speedTest(urls: string[], log: (s: string) => void, dispatcher?: Dispatcher): Promise<string[]> {
  if (urls.length <= 1) return urls;
  const pool = urls.slice(0, ACCEL_PROBE_LIMIT);
  const rest = urls.slice(ACCEL_PROBE_LIMIT);
  log(`正在为 ${pool.length} 条下载线路测速…`);
  const small = await collectSamples(pool, PROBE_SMALL, ACCEL_PROBE_CONCURRENCY, dispatcher);
  const alive = small
    .filter((s) => s.ok && s.bytes >= SPEED_MIN_BYTES)
    .sort((a, b) => sampleBps(b) - sampleBps(a));
  for (const s of alive.slice(0, 8)) {
    log(`测速(小样本)：${hostOf(s.url)} ${Math.round(sampleBps(s) / 1024)} KB/s（${Math.round(s.ms - (s.ttfb || 0))}ms）`);
  }
  if (!alive.length) {
    log(`测速：${pool.length} 条候选全部不可用（改按原顺序尝试下载）`);
    return [...pool, ...rest];
  }
  const finalists = alive.slice(0, ACCEL_FINALISTS);
  log(`正在复测前 ${finalists.length} 名…`);
  const big = await collectSamples(finalists.map((s) => s.url), PROBE_BIG, finalists.length, dispatcher);
  for (const s of big) {
    log(`测速(复测)：${hostOf(s.url)} ${Math.round(sampleBps(s) / 1024)} KB/s（${s.bytes}B/${s.ms}ms）`);
  }
  const ranked = [
    ...rankBySpeed(big, SPEED_MIN_BYTES),
    ...alive.slice(ACCEL_FINALISTS).map((s) => s.url),
    ...small.filter((s) => !alive.includes(s)).map((s) => s.url),
    ...rest,
  ];
  const best = big.find((s) => s.url === ranked[0]) || finalists.find((s) => s.url === ranked[0]);
  if (best) log(`→ 最快线路：${hostOf(best.url)}（${Math.round(sampleBps(best) / 1024)} KB/s）`);
  return [...new Set(ranked)];
}

/**
 * 单线路下载到内存 Buffer。支持：
 * - 手动跟随 3xx 重定向（最多 8 次）
 * - 滚动窗口速度门限：窗口（默认 10s）内平均速度 < minSpeedBps 时 abort 并抛 SPEED_TOO_LOW
 */
async function downloadOneBuffer(
  url: string,
  expectSize: number,
  log: (s: string) => void,
  depth: number,
  opts: { minSpeedBps?: number; speedWindowMs?: number },
  dispatcher?: Dispatcher,
): Promise<Buffer> {
  const { minSpeedBps = 0, speedWindowMs = SPEED_WINDOW_MS } = opts;
  const ac = new AbortController();
  let abortedBySpeed = false;
  let speedCheck: ReturnType<typeof setInterval> | null = null;
  let received = 0;

  const res = await undiciRequest(url, {
    method: 'GET',
    headers: { 'User-Agent': UA },
    headersTimeout: 20000,
    bodyTimeout: 0,
    signal: ac.signal,
    dispatcher,
  });

  const loc = res.headers['location'];
  if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
    await res.body.dump();
    if (depth >= MAX_REDIRECTS) throw new Error('重定向次数过多');
    const next = new URL(String(loc), url).toString();
    return downloadOneBuffer(next, expectSize, log, depth + 1, opts, dispatcher);
  }
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    await res.body.dump();
    throw new Error(`HTTP ${res.statusCode}`);
  }

  const total = Number(res.headers['content-length']) || expectSize || 0;
  const chunks: Buffer[] = [];
  let lastT = Date.now();
  let lastB = 0;
  let speed = 0;

  if (minSpeedBps > 0) {
    const t0 = Date.now();
    const samples = [{ t: t0, bytes: 0 }];
    speedCheck = setInterval(() => {
      if (abortedBySpeed) return;
      const now = Date.now();
      samples.push({ t: now, bytes: received });
      while (samples.length > 2 && now - samples[0].t > speedWindowMs) samples.shift();
      const oldest = samples[0];
      const elapsed = now - oldest.t;
      if (samples.length >= 2 && elapsed >= speedWindowMs * 0.9) {
        const bps = ((received - oldest.bytes) * 1000) / elapsed;
        if (bps < minSpeedBps) {
          abortedBySpeed = true;
          if (speedCheck) { clearInterval(speedCheck); speedCheck = null; }
          ac.abort();
        }
      }
    }, 500);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      res.body.on('data', (c: Buffer) => {
        chunks.push(c);
        received += c.length;
        const now = Date.now();
        if (now - lastT >= 300) {
          speed = Math.round(((received - lastB) * 1000) / (now - lastT));
          lastT = now;
          lastB = received;
          if (total) {
            const percent = Math.min(99, Math.floor((received * 100) / total));
            if (percent % 20 === 0) log(`下载 ${percent}%（${Math.round(speed / 1024)} KB/s）`);
          }
        }
      });
      res.body.on('end', () => resolve());
      res.body.on('error', (e: Error) => reject(e));
    });
  } catch (e) {
    if (abortedBySpeed) {
      const err = new Error(
        `平均速度持续低于 ${(minSpeedBps / 1024 / 1024).toFixed(1)} MB/s（${speedWindowMs / 1000}s 窗口），触发换线路`,
      ) as Error & { abortedBySpeed?: boolean; code?: string };
      err.code = 'SPEED_TOO_LOW';
      err.abortedBySpeed = true;
      throw err;
    }
    throw e;
  } finally {
    if (speedCheck) { clearInterval(speedCheck); speedCheck = null; }
  }

  if (total && received !== total) {
    log(`下载：字节数不符（收到 ${received} / 预期 ${total}）`);
  }
  return Buffer.concat(chunks, received);
}

/**
 * 加速下载：构建候选、测速排名、按顺序尝试；速度低于门限自动换线（最多重测 MAX_RETESTS 次）。
 * 调用方只传原始 GitHub URL（或非 GitHub URL），本函数负责决定是否加前缀。
 */
export async function downloadWithAccel(url: string, opts: AccelOptions = {}): Promise<Buffer> {
  const log = opts.log || (() => undefined);
  const dispatcher = opts.dispatcher;
  const minSpeedBps = opts.minSpeedBps ?? MIN_DOWNLOAD_BPS;
  const speedWindowMs = opts.speedWindowMs ?? SPEED_WINDOW_MS;

  const raw = (url || '').trim();
  if (!raw) throw new Error('地址为空');

  if (!isGitHubUrl(raw)) {
    log(`非 GitHub 地址，直接下载：${hostOf(raw)}`);
    return downloadOneBuffer(raw, 0, log, 0, { minSpeedBps: 0, speedWindowMs }, dispatcher);
  }

  const candidates = buildAccelUrls(raw);
  log(`GitHub 地址，候选线路 ${candidates.length} 条（含直连兜底）`);

  let urls = candidates;
  try { urls = await speedTest(candidates, log, dispatcher); }
  catch (e) { log(`测速失败（改按原顺序下载）：${(e as Error).message}`); }

  let remaining = urls.slice();
  let retestCount = 0;
  let lastErr = '下载失败';

  while (remaining.length > 0) {
    const u = remaining.shift()!;
    const host = hostOf(u);
    log(`尝试 ${host}`);
    try {
      const buf = await downloadOneBuffer(u, 0, log, 0, { minSpeedBps, speedWindowMs }, dispatcher);
      log(`完成 ${host}（${buf.length}B）`);
      return buf;
    } catch (e) {
      lastErr = (e as Error).message || String(e);
      const abortedBySpeed = !!(e as { abortedBySpeed?: boolean }).abortedBySpeed;
      if (abortedBySpeed) {
        log(`⚡ ${host} 平均速度低于 ${(minSpeedBps / 1024 / 1024).toFixed(1)} MB/s（${speedWindowMs / 1000}s），准备切换线路`);
        if (retestCount < MAX_RETESTS && remaining.length > 0) {
          retestCount++;
          log(`重新测速中（第 ${retestCount}/${MAX_RETESTS} 次）…`);
          try {
            const ranked = await speedTest([...remaining, u], log, dispatcher);
            remaining = ranked.filter((x) => x !== u).concat([u]);
          } catch (e2) {
            log(`重新测速失败（保留原顺序）：${(e2 as Error).message}`);
          }
        } else if (retestCount >= MAX_RETESTS) {
          log(`⚡ 已重测 ${MAX_RETESTS} 次，按剩余顺序继续尝试`);
        }
      } else {
        log(`下载失败（${host}）：${lastErr}`);
      }
    }
  }
  throw new Error(`加速下载失败（已尝试 ${candidates.length} 条线路）：${lastErr}`);
}
