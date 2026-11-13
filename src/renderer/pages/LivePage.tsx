// src/renderer/pages/LivePage.tsx
// ★ 2026-11-13（用户要求）：网络直播源更新时的精细 diff —— 不无脑重置播放。
//   · 名字变了、URL 没变 → 只刷新 groups / 频道列表，playUrl 不动，播放继续；
//   · 当前频道 URL 变了 → setPlayUrl(新地址)，LiveVideoPlayer 因 key 变化重挂，用新地址播；
//   · 当前频道在新源里找不到 / 订阅源更新失败 → 保留旧 groups + 旧 playUrl，继续播。
//   · 订阅更新后 loadLive 用 { forceRefresh: true } 绕过 5 分钟内存缓存，groups 一换 →
//     下方 [groups] 依赖的 EPG useEffect 自动重新拉 EPG，与新源保持一致。
import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { client } from '../api/client';
import { ipcInvoke } from '../api/ipc';
import type {
  LiveGroup,
  LiveBean,
  LiveEpgEntry,
  EpgChannelRef,
  LiveSubscription,
} from '../../shared/types';
import { splitLine } from '../../engine/live/LiveUtils';

// ---- 频道选择记忆 ----
const LIVE_MEM_KEY = 'winbox-live-mem';
interface LiveMem { liveIdx?: number; groupName?: string; channelName?: string; lineIdx?: number }
function loadLiveMem(): LiveMem {
  try { return JSON.parse(localStorage.getItem(LIVE_MEM_KEY) || '{}') as LiveMem; } catch { return {}; }
}
function saveLiveMem(m: LiveMem): void {
  try { localStorage.setItem(LIVE_MEM_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

type EpgStatus = 'idle' | 'loading' | 'ok' | 'empty' | 'error';

// ★ 与 main/LiveSubscriptionManager.ts 里的 LiveSubChangedPayload 对齐
//   （preload 不暴露那个类型，渲染层自己声明一份）
interface LiveSubChangedPayload {
  updated: boolean;
  updatedIds: string[];
  failedIds: string[];
  reason: 'startup' | 'manual' | 'crud';
}

class StreamDetector {
  static async detect(url: string): Promise<'hls' | 'flv' | 'ts' | 'native' | 'unknown'> {
    const lower = url.toLowerCase();
    if (lower.includes('.m3u8')) return 'hls';
    if (lower.includes('.flv')) return 'flv';
    if (/\.ts(\?|#|$)/.test(lower)) return 'ts';
    if (/\.(mp4|mkv|mov|webm|m4v|avi)(\?|#|$)/.test(lower)) return 'native';
    try {
      const res = await fetch(url, { method: 'HEAD', mode: 'cors' });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('mpegurl') || ct.includes('m3u8')) return 'hls';
      if (ct.includes('flv')) return 'flv';
      if (ct.includes('mp2t') || ct.includes('mpegts')) return 'ts';
      if (ct.includes('video/') || ct.includes('audio/')) return 'native';
    } catch {
      try {
        const res = await fetch(url, { method: 'GET', mode: 'cors' });
        const text = await res.text();
        if (text.trim().startsWith('#EXTM3U')) return 'hls';
        if (text.includes('FLV')) return 'flv';
        return 'hls';
      } catch {
        return 'unknown';
      }
    }
    return 'hls';
  }
}

function LiveVideoPlayer({
  url,
  onReconnect,
  onVideoError,
}: {
  url: string;
  onReconnect: () => void;
  onVideoError: (msg: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<any>(null);
  const mpegtsRef = useRef<any>(null);
  const cbRef = useRef({ onReconnect, onVideoError });
  cbRef.current = { onReconnect, onVideoError };

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url) return;

    let destroyed = false;
    const destroyHls = () => { if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; } };
    const destroyMpegts = () => { if (mpegtsRef.current) { try { mpegtsRef.current.destroy(); } catch {} mpegtsRef.current = null; } };

    const safePlay = () => {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    };

    const playNative = () => {
      v.src = url;
      v.load();
      safePlay();
    };

    const playHls = (sourceUrl: string) => {
      if (!Hls.isSupported()) { playNative(); return; }
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 20,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 500,
        levelLoadingTimeOut: 15000,
        fragLoadingTimeOut: 30000,
        xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = false; },
      });
      hlsRef.current = hls;
      hls.loadSource(sourceUrl);
      hls.attachMedia(v);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (destroyed) return;
        safePlay();
      });

      hls.on(Hls.Events.ERROR, (_evt: unknown, data: any) => {
        if (destroyed) return;
        if (!data?.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          cbRef.current.onVideoError('HLS 网络错误，尝试恢复…');
          try { hls.startLoad(); } catch {}
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          cbRef.current.onVideoError('HLS 解码错误，尝试恢复…');
          try { hls.recoverMediaError(); } catch {}
        } else {
          cbRef.current.onVideoError(`HLS 失败：${data.details || data.type}`);
          destroyHls();
          cbRef.current.onReconnect();
        }
      });
    };

    const playMpegts = async (type: 'flv' | 'mpegts', sourceUrl: string) => {
      try {
        // @ts-ignore 动态加载可选依赖
        const mod = await import(/* @vite-ignore */ 'mpegts.js').catch(() => null);
        const mpegts: any = (mod as any)?.default || (mod as any);
        if (!mpegts || typeof mpegts.isSupported !== 'function' || !mpegts.isSupported()) {
          playNative();
          return;
        }
        const player = mpegts.createPlayer(
          { type, url: sourceUrl, isLive: true },
          { enableWorker: true, enableStashBuffer: false, stashInitialSize: 128, lazyLoad: false },
        );
        mpegtsRef.current = player;
        player.attachMediaElement(v);
        player.load();
        try { player.play(); } catch {}
        player.on(mpegts.Events?.ERROR || 'error', (errType: unknown, errDetail: unknown) => {
          cbRef.current.onVideoError(`流错误：${errType}/${errDetail}`);
          cbRef.current.onReconnect();
        });
      } catch {
        playNative();
      }
    };

    (async () => {
      const kind = await StreamDetector.detect(url);
      if (destroyed) return;
      if (kind === 'hls') playHls(url);
      else if (kind === 'flv') void playMpegts('flv', url);
      else if (kind === 'ts') void playMpegts('mpegts', url);
      else if (kind === 'native') playNative();
      else playHls(url);
    })();

    const onEnded = () => cbRef.current.onReconnect();
    const onErr = () => {
      const err = v.error;
      const code = err?.code;
      const msg = code === 1 ? '用户中止' : code === 2 ? '网络错误' : code === 3 ? '解码错误' : code === 4 ? '源不支持' : `错误(${code ?? '?'})`;
      cbRef.current.onVideoError(msg);
      if (code === 2 || code === 4) cbRef.current.onReconnect();
    };
    const onPlaying = () => cbRef.current.onVideoError('');
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onErr);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('play', onPlaying);

    return () => {
      destroyed = true;
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onErr);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('play', onPlaying);
      destroyHls();
      destroyMpegts();
      try { v.removeAttribute('src'); v.load(); } catch {}
    };
  }, [url]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      controls
      style={{ width: '100%', height: '100%', background: '#000', display: 'block' }}
    />
  );
}

export default function LivePage() {
  const [lives, setLives] = useState<LiveBean[]>([]);
  const [liveIdx, setLiveIdx] = useState(0);
  const [groups, setGroups] = useState<LiveGroup[]>([]);
  const [groupName, setGroupName] = useState('');
  const [channelName, setChannelName] = useState('');
  const [lineIdx, setLineIdx] = useState(0);
  const [playUrl, setPlayUrl] = useState('');
  const [playbackUrl, setPlaybackUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [epg, setEpg] = useState<Record<string, LiveEpgEntry>>({});
  const [epgStatus, setEpgStatus] = useState<EpgStatus>('idle');
  const epgTimer = useRef<number | null>(null);

  const [subCount, setSubCount] = useState(0);
  const [subEnabled, setSubEnabled] = useState(0);

  const [reconnectKey, setReconnectKey] = useState(0);
  const [reconnectMsg, setReconnectMsg] = useState('');
  const reconnectCountRef = useRef(0);
  const lastReconnectAtRef = useRef(0);
  const MAX_RECONNECT = 50;

  // ★ 2026-11-13：把「当前播放上下文」用 ref 存一份，供订阅更新回调读取
  //   （避免把 liveIdx/groupName/... 都放进 useEffect 依赖导致频繁重订阅）
  const playStateRef = useRef({ liveIdx, groupName, channelName, lineIdx, playUrl });
  useEffect(() => {
    playStateRef.current = { liveIdx, groupName, channelName, lineIdx, playUrl };
  }, [liveIdx, groupName, channelName, lineIdx, playUrl]);

  useEffect(() => {
    if (!playUrl) { setPlaybackUrl(''); return; }
    setPlaybackUrl(playUrl);
    reconnectCountRef.current = 0;
    lastReconnectAtRef.current = 0;
    setReconnectMsg('');
  }, [playUrl]);

  const doReconnect = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectAtRef.current < 3000) return;
    lastReconnectAtRef.current = now;
    reconnectCountRef.current += 1;
    const n = reconnectCountRef.current;
    if (n > MAX_RECONNECT) {
      setReconnectMsg(`已连续重连 ${MAX_RECONNECT} 次仍失败，请切换线路`);
      return;
    }
    setReconnectMsg(`断线重连中…（第 ${n} 次）`);
    setReconnectKey((k) => k + 1);
    window.setTimeout(() => {
      setReconnectMsg((cur) => (cur.startsWith('断线重连中') ? '' : cur));
    }, 3000);
  }, []);

  const handleVideoError = useCallback((msg: string) => {
    if (msg) setReconnectMsg(msg);
  }, []);

  const reloadLives = useCallback(async () => {
    try {
      const cfg = await client.cfgGet();
      const m = await client.liveMeta();
      setLives(m);
      const idx = liveIdx < m.length ? liveIdx : 0;
      setLiveIdx(idx);
      if (m.length && idx !== liveIdx) {
        await loadLiveInternal(idx, m);
      }
    } catch (e) {
      console.warn('[Live] reload lives 失败：', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx]);

  /**
   * ★ 2026-11-13：加 `forceRefresh` 参数 —— 订阅源更新后调用时传 true，
   *   绕过 SpiderHost.loadLive 的 5 分钟内存缓存，拿到真实新 groups + 新 EPG URL。
   *   普通切线路 / 首次加载不传（走缓存，快）。
   */
  async function loadLiveInternal(index: number, meta?: LiveBean[], forceRefresh = false) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLoading(true);
    setErr('');
    try {
      const r = await client.loadLive(index, { forceRefresh });
      setGroups(r.groups);
      if (r.groups.length) {
        const mem = loadLiveMem();
        const fromMem = mem.liveIdx === index;
        const g = fromMem && mem.groupName ? r.groups.find((x) => x.group === mem.groupName) : undefined;
        const group = g || r.groups[0];
        setGroupName(group.group);
        const ch = fromMem && mem.channelName && group.channels.some((c) => c.name === mem.channelName)
          ? group.channels.find((c) => c.name === mem.channelName)!
          : group.channels[0];
        if (group.channels.length && ch) {
          pickChannelInternal(group, ch.name, fromMem ? (mem.lineIdx || 0) : 0, r.groups, index);
        }
      } else {
        setGroups([]);
        setGroupName('');
        setChannelName('');
        setPlayUrl('');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function pickLive(index: number, meta?: LiveBean[]) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLiveIdx(index);
    client.cfgSetActiveLive(index).catch(() => undefined);
    void loadLiveInternal(index, m);
  }

  function pickChannelInternal(g: LiveGroup, name: string, li: number, all = groups, idx = liveIdx) {
    setGroupName(g.group);
    setChannelName(name);
    setLineIdx(li);
    saveLiveMem({ liveIdx: idx, groupName: g.group, channelName: name, lineIdx: li });
    const ch = g.channels.find((c) => c.name === name);
    if (ch && ch.urls.length) {
      const line = splitLine(ch.urls[li] || ch.urls[0], li + 1);
      setPlayUrl(line.url);
    }
    if (all !== groups) setGroups(all);
  }
  const pickChannel = pickChannelInternal;

  const loadSubStatus = useCallback(async () => {
    try {
      const list = await ipcInvoke<LiveSubscription[]>('live:subscription:list');
      const arr = Array.isArray(list) ? list : [];
      setSubCount(arr.length);
      setSubEnabled(arr.filter((s) => s.enabled).length);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await client.cfgGet();
        const m = await client.liveMeta();
        if (cancelled) return;
        setLives(m);
        if (m.length) {
          const start = cfg.ui.activeLiveIndex < m.length ? cfg.ui.activeLiveIndex : 0;
          setLiveIdx(start);
          await loadLiveInternal(start, m);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    void loadSubStatus();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * ★ 2026-11-13（用户要求）：订阅源内容有变化 → 精细 diff，不做无脑重置。
   *
   *   步骤：
   *   1) 拿新线路列表（lives），若当前 liveIdx 越界则 clamp；
   *   2) 拿新 groups（client.loadLive(idx, { forceRefresh: true }) —— 绕过 5 分钟缓存）；
   *   3) diff 当前正在播的 {groupName, channelName, lineIdx}：
   *      · 频道还在、URL 没变 → 只 setGroups（刷新 UI 名称/列表），playUrl 不动；
   *        groups 一变，依赖它的 EPG useEffect 自动用新 EPG URL 重拉；
   *      · 频道还在、URL 变了 → setGroups + setPlayUrl(新 URL)，触发重播 + EPG 重拉；
   *      · 频道没了 → 不 setGroups、不动 playUrl（保留旧列表 + 旧地址继续播）；
   *   4) 任何异常 → 静默（保底旧播放继续）。
   */
  const applySubscriptionUpdate = useCallback(async () => {
    const cur = playStateRef.current;
    try {
      const newMeta = await client.liveMeta();
      if (!Array.isArray(newMeta) || newMeta.length === 0) {
        console.warn('[Live] 订阅更新后线路列表为空，保留旧列表与旧地址继续播放');
        return;
      }
      setLives(newMeta);

      const idx = cur.liveIdx < newMeta.length ? cur.liveIdx : 0;
      if (idx !== cur.liveIdx) setLiveIdx(idx);

      // ★ forceRefresh: true —— 绕过 5 分钟内存缓存，拿真实新 groups + 新 EPG URL
      const r = await client.loadLive(idx, { forceRefresh: true });
      const newGroups = r.groups;

      // 没有在播内容 → 只更新列表，让用户自己选
      if (!cur.groupName || !cur.channelName) {
        setGroups(newGroups);
        return;
      }

      // 找当前正在播的频道
      const curGroup = newGroups.find((g) => g.group === cur.groupName);
      const curChannel = curGroup?.channels.find((c) => c.name === cur.channelName);

      if (!curGroup || !curChannel) {
        // ★ 频道在新源里已消失：保留旧 groups + 旧 playUrl，继续播
        console.info('[Live] 当前频道已从更新后的源中消失，保留旧列表与旧地址继续播放');
        return;
      }

      // 频道还在 → 更新 groups（UI 名称/频道列表跟着变）
      setGroups(newGroups);

      const newLine = splitLine(curChannel.urls[cur.lineIdx] || curChannel.urls[0], cur.lineIdx + 1);
      const newUrl = newLine.url || '';
      if (newUrl && newUrl !== cur.playUrl) {
        // ★ URL 变了 → 用新地址重播
        console.info('[Live] 当前频道地址已更新，使用新地址重播');
        setPlayUrl(newUrl);
      } else {
        // ★ URL 没变 → 只刷新 UI，不动 playUrl，播放继续
        console.info('[Live] 当前频道地址未变，仅刷新频道列表');
      }
    } catch (e) {
      console.warn('[Live] 处理订阅更新失败（保留旧播放继续）：', e);
    }
  }, []);

  // ★ 2026-11-13：监听主进程广播的订阅更新（带 payload），做精细 diff
  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:subscriptions-changed', (payload?: LiveSubChangedPayload) => {
      void loadSubStatus();

      // 没有 payload（旧版主进程广播）→ 兼容处理：视为 CRUD，仅刷新线路列表
      if (!payload) {
        void reloadLives();
        return;
      }

      // 内容没有更新（只有失败 / 纯 CRUD）：
      //   · 失败：保留旧播放继续，只是订阅计数变了（已由 loadSubStatus 处理）；
      //   · CRUD（增删改订阅源）：刷新线路列表（可能删除的就是当前线路）。
      if (!payload.updated) {
        if (payload.reason === 'crud') void reloadLives();
        return;
      }

      // 有内容更新 → 精细 diff
      void applySubscriptionUpdate();
    });
    return () => { if (typeof off === 'function') off(); };
  }, [loadSubStatus, reloadLives, applySubscriptionUpdate]);

  // ★ 2026-10-14（用户要求）：监听主进程广播的「直播源已变更」→ 自动重新加载
  //   （来自配置页「导入本地 TXT/M3U」，与网络订阅源的精细 diff 分开处理）
  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:changed', (payload: { index?: number; name?: string; replaced?: boolean }) => {
      console.log('[Live] 收到 live:changed 广播：', payload);
      void (async () => {
        try {
          const m = await client.liveMeta();
          setLives(m);
          const idx = liveIdx < m.length ? liveIdx : 0;
          if (idx !== liveIdx) setLiveIdx(idx);
          if (m.length) {
            await loadLiveInternal(idx, m);
          }
        } catch (e) {
          console.warn('[Live] live:changed 处理后失败：', e);
        }
      })();
    });
    return () => { if (typeof off === 'function') off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx]);

  const curGroup = groups.find((g) => g.group === groupName);
  const curChannel = curGroup?.channels.find((c) => c.name === channelName);
  const curEpg = curChannel ? (epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name]) : undefined;
  const lines = curChannel ? curChannel.urls.map((u, i) => splitLine(u, i + 1)) : [];

  async function refreshEpg(index: number, gs: LiveGroup[], currentChannelName: string) {
    if (!currentChannelName) { setEpg({}); setEpgStatus('empty'); return; }
    const refs: EpgChannelRef[] = [];
    outer: for (const g of gs) {
      for (const c of g.channels) {
        if (c.name !== currentChannelName) continue;
        const r: EpgChannelRef = {
          tvgId: c['tvg-id'],
          tvgName: c['tvg-name'],
          name: c.name,
          epg: c.epg,
        };
        if (r.tvgId || r.tvgName || r.name) refs.push(r);
        break outer;
      }
    }
    if (!refs.length) { setEpg({}); setEpgStatus('empty'); return; }
    setEpgStatus('loading');
    try {
      const r = await client.liveEpg(index, refs);
      setEpg(r.byKey);
      setEpgStatus(Object.keys(r.byKey).length ? 'ok' : 'empty');
    } catch (e) {
      setEpg({});
      setEpgStatus('error');
      console.warn('[EPG] 加载失败：', e);
    }
  }

  // ★ 2026-11-13：订阅更新后 groups 一换，这里会自动用新 EPG URL 重拉 EPG
  useEffect(() => {
    if (!groups.length) return;
    void refreshEpg(liveIdx, groups, channelName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx, groups, channelName]);

  useEffect(() => {
    if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    if (!curChannel) return;
    const e = epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name];
    const at = e?.current?.endTime ?? e?.next?.startTime;
    if (!at) return;
    const delay = Math.max(1000, Math.min(at - Date.now() + 1000, 6 * 3600 * 1000));
    epgTimer.current = window.setTimeout(() => { void refreshEpg(liveIdx, groups, channelName); }, delay);
    return () => {
      if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epg, groupName, channelName, liveIdx]);

  async function openPrograms(channel: { name: string; 'tvg-id'?: string; 'tvg-name'?: string }) {
    const name = (channel.name || '').trim();
    if (!name) return;
    const groupList = groups
      .map((g) => ({
        group: String(g.group || '').trim(),
        channels: g.channels
          .map((c) => ({
            name: String(c.name || '').trim(),
            tvgId: String(c['tvg-id'] || '').trim(),
            tvgName: String(c['tvg-name'] || '').trim(),
          }))
          .filter((c) => !!c.name),
      }))
      .filter((g) => !!g.group && g.channels.length > 0);
    try {
      await ipcInvoke('epg:openWindow', {
        channelName: name,
        tvgId: (channel['tvg-id'] || '').trim(),
        tvgName: (channel['tvg-name'] || '').trim(),
        groups: groupList,
        currentGroup: groupName,
      });
    } catch (e) {
      console.warn('[EPG] 打开节目单窗口失败', e);
    }
  }

  const epgStatusText =
    epgStatus === 'loading' ? '加载中…'
      : epgStatus === 'ok' ? `命中 ${Object.keys(epg).length} 键`
        : epgStatus === 'empty' ? '无节目单'
          : epgStatus === 'error' ? '失败（看日志）'
            : '未触发';

  return (
    <>
      <div className="topbar">
        <select value={liveIdx} onChange={(e) => pickLive(Number(e.target.value))} disabled={loading}>
          {lives.map((l, i) => <option key={i} value={i}>{l.name}</option>)}
        </select>

        <span className="status" style={{ marginLeft: 'auto' }}>
          {loading ? '加载中…' : `${groups.length} 组`}
        </span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          订阅 {subEnabled}/{subCount}
        </span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          EPG：{epgStatusText}
        </span>
      </div>

      <div className="layout-2 content" style={{ padding: 12 }}>
        <div className="left">
          {groups.map((g) => (
            <div
              key={g.group}
              className={`nav-item ${g.group === groupName ? 'active' : ''}`}
              onClick={() => {
                setGroupName(g.group);
                if (g.channels.length) pickChannel(g, g.channels[0].name, 0, groups);
              }}
            >
              {g.group} <span className="muted">({g.channels.length})</span>
            </div>
          ))}
        </div>
        <div className="right">
          {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
          {curGroup ? (
            <>
              <div className="row" style={{ marginBottom: 10, maxHeight: 180, overflow: 'auto' }}>
                {curGroup.channels.map((c) => (
                  <span
                    key={c.name}
                    className={`tag ${c.name === channelName ? 'active' : ''}`}
                    onClick={() => pickChannel(curGroup, c.name, 0, groups)}
                    onDoubleClick={() => openPrograms(c)}
                    title="双击查看完整节目单（独立窗口，可拖到屏幕任意位置）"
                  >
                    {c.name}
                  </span>
                ))}
              </div>
              {lines.length > 1 && (
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="muted">线路：</span>
                  {lines.map((l) => (
                    <span
                      key={l.index}
                      className={`tag ${l.index - 1 === lineIdx ? 'active' : ''}`}
                      onClick={() => {
                        setLineIdx(l.index - 1);
                        setPlayUrl(l.url);
                        saveLiveMem({ liveIdx, groupName, channelName, lineIdx: l.index - 1 });
                      }}
                    >
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
              {curEpg && (curEpg.current || curEpg.next) && curChannel && (
                <div
                  className="live-epg"
                  onClick={() => openPrograms(curChannel)}
                  style={{ cursor: 'pointer' }}
                  title="点击查看完整节目单（独立窗口，可拖到屏幕任意位置）"
                >
                  {curEpg.current && (
                    <span className="live-epg-now">
                      <b>正在播</b> {curEpg.current.start}~{curEpg.current.end} {curEpg.current.title || '（无标题）'}
                    </span>
                  )}
                  {curEpg.next && (
                    <span className="muted">
                      <b>下一档</b> {curEpg.next.start} {curEpg.next.title || '（无标题）'}
                    </span>
                  )}
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>📺</span>
                </div>
              )}

              {playUrl ? (
                <div className="live-player" style={{ position: 'relative' }}>
                  {playbackUrl ? (
                    <LiveVideoPlayer
                      key={`${playbackUrl}__${reconnectKey}`}
                      url={playbackUrl}
                      onReconnect={doReconnect}
                      onVideoError={handleVideoError}
                    />
                  ) : (
                    <div className="empty" style={{ width: '100%', height: '100%' }}>加载中…</div>
                  )}
                  {reconnectMsg && (
                    <div
                      style={{
                        position: 'absolute', top: 12, left: 12,
                        padding: '6px 12px', borderRadius: 6,
                        background: 'rgba(0,0,0,0.7)', color: '#ffb74d', fontSize: 13,
                        pointerEvents: 'none', zIndex: 20,
                      }}
                    >{reconnectMsg}</div>
                  )}
                </div>
              ) : (
                <div className="empty">无播放地址</div>
              )}
            </>
          ) : (
            <div className="empty">{groups.length ? '选择左侧分组' : '无直播（请先导入含 lives 的配置）'}</div>
          )}
        </div>
      </div>
    </>
  );
}
