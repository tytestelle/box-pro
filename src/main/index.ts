// src/main/index.ts — Electron 主进程入口
// ★★ 第一条 import（import 即执行，勿挪位置）：把数据目录切到**安装目录/data**，
//   并在老用户首次启动时自动迁移 %APPDATA%\win-box（见 dataDirBootstrap.ts 头注释）。
//   必须早于 logger / 各 Store 的模块求值，否则它们会把路径解析到旧位置。
import { dataDirReport } from './util/dataDirBootstrap';
import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { registerIpc } from './ipc';
import { SpiderHost } from './spider/SpiderHost';
import { LocalProxyServer } from './server/LocalProxyServer';
import { fileLogger } from './util/logger';
import { applyWindowCorner } from './util/windowCorner';
import { bossKey } from './bossKey';
import { playerWindow, onPlayerWindowClosed } from './player/PlayerWindow';
import { playerSettings } from './player/playerSettings';
// ★ 2026-11-10（用户要求）：广告屏蔽 —— `hostRegexFor` 取订阅规则，`builtinAdRegex` 取软件内置规则；
//   两者在 proxy 构造里拼接，因此订阅没写规则也能清洗「赌场/娱乐城」等内置关键词。
//   关键词可由配置页「m3u8 去广告 · 规则」按钮编辑，持久化在 main/player/adKeywordSettings.ts。
import { hostRegexFor, builtinAdRegex } from '../engine/util/m3u8Purify';
import { adKeywordSettings } from './player/adKeywordSettings';
import { TorrentPlay } from './torrent/torrentPlay';
import { DavService } from './webdav/DavService';
import { DlnaService } from './dlna/DlnaService';
import { UpdateService } from './update/UpdateService';
import { DavStore } from './store/DavStore';
import { JsonStore } from './store/JsonStore';
import { LocalPkgStore } from './store/LocalPkgStore';
import { LOCAL_PROXY_BASE } from '../shared/constants';
import { localImportsDir, userDataDir } from './util/paths';
import { safeStorageDriveCodec } from './util/driveCodec';
// ★ 2026-10-13：订阅源相关（IPC 注册 + 本地导入函数注入 + 启动自动检查更新）
import {
  registerLiveSubscriptionIpc,
  bindLiveImporter,
  checkAndUpdateSubscriptions,
} from './LiveSubscriptionManager';
import { importLiveFileFromPath } from './live/importLiveFile';
// esbuild 打成 CJS：__dirname 由 Node 提供（= dist/）。资源在 dist/../../resources。
declare const __dirname: string;

let mainWindow: BrowserWindow | null = null;
const host = new SpiderHost();
/**
 * ★ 2026-09-29：磁力（BT）引擎（用户选定方案 B）—— aria2c sidecar + 本机中继 `/bt` + 外部播放器接力。
 * 懒启动（首次磁力播放才拉起 aria2c），退出时 dispose（另有 `--stop-with-process` 兜底防孤儿）。
 */
const torrent = new TorrentPlay(fileLogger, () => playerSettings.settings.btExternalPlayer);
host.torrentPlay = torrent;
/**
 * ★ 2026-09-29 WebDAV 存储（用户选定「WebDAV 直连」）：服务器与凭据加密落盘，
 * 浏览走 PROPFIND、播放走 `/play?dav=<id>` 由中继注入 Authorization（凭据绝不进 URL）。
 */
const dav = new DavService(
  new DavStore(new JsonStore(join(userDataDir(), 'webdav-servers.json')), fileLogger, safeStorageDriveCodec()),
  fileLogger,
);
/** ★ 2026-09-29 DLNA 投屏（SSDP 发现 + AVTransport 三动作；对位 CatClaw Dlna.cs = TVBox osc/dlna） */
const dlna = new DlnaService(fileLogger);
/**
 * ★★ 2026-10-13（用户要求「屏蔽软件的更新功能」）★★
 *   用**哑更新器**替换真实 UpdateService。
 */
const updater = (() => {
  const CURRENT_VERSION = app.getVersion();
  const noopCheck = async () => ({
    hasUpdate: false,
    updateAvailable: false,
    available: false,
    needUpdate: false,
    shouldUpdate: false,
    hasNewVersion: false,
    forced: false,
    mandatory: false,
    forceUpdate: false,
    current: CURRENT_VERSION,
    currentVersion: CURRENT_VERSION,
    localVersion: CURRENT_VERSION,
    latest: CURRENT_VERSION,
    latestVersion: CURRENT_VERSION,
    version: CURRENT_VERSION,
    tag: CURRENT_VERSION,
    tagName: CURRENT_VERSION,
    tag_name: CURRENT_VERSION,
    version_name: CURRENT_VERSION,
    remoteVersion: CURRENT_VERSION,
    downloadUrl: '',
    url: '',
    notes: '',
    releaseNotes: '',
    body: '',
    publishedAt: '',
    name: '',
  });

  const noopDownload = async () => ({ ok: false, error: '更新功能已禁用' });
  const noopLaunch = async () => ({ ok: false, error: '更新功能已禁用' });
  const noopDownloadedPath = () => null as string | null;

  return {
    check: noopCheck,
    download: noopDownload,
    downloadedPath: noopDownloadedPath,
    launch: noopLaunch,
  } as unknown as UpdateService;
})();
/**
 * ★ 2026-09-29（用户要求）本地包：登记表 + `/pkg` 资源路由 + py 就地运行。
 */
const localPkgs = new LocalPkgStore(new JsonStore(join(userDataDir(), 'local-pkgs.json')), LOCAL_PROXY_BASE, localImportsDir());
const proxy = new LocalProxyServer(
  fileLogger,
  () => host.driveList(),
  // ★ 2026-09-29 m3u8 去广告注入（默认关，配置页「播放」可开）：
  //   开关每轮清单回源时现读（改后即时生效）；规则 = 当前订阅的 rules[].regex + 软件内置关键词规则。
  //   ★ 2026-11-10：`builtinAdRegex(strong, weak)` 用用户当前关键词（配置页「规则」按钮可编辑）；
  //   `adsFor()` 把订阅 `ads` 域名黑名单交给 /play 入口（命中即 204，始终生效，不依赖 m3u8 去广告开关）；
  //   `strongKeywordsFor()` 把用户强关键词交给 /play 入口的 URL 级拦截。
  {
    enabled: () => playerSettings.settings.m3u8Purify,
    rulesFor: (url) => [
      ...hostRegexFor(url, host.siteConfig?.rules),
      ...builtinAdRegex(adKeywordSettings.settings.strong, adKeywordSettings.settings.weak),
    ],
    adsFor: () => host.siteConfig?.ads || [],
    strongKeywordsFor: () => adKeywordSettings.settings.strong,
  },
  (id) => dav.authHeader(id),
);
// ★ 2026-09-29（用户要求）本地包：包内资源路由（/pkg/<i>/<rel>）+ 订阅 pkg:// 读取
proxy.pkgRoot = (i) => localPkgs.rootOf(i);
host.localPkgs = localPkgs;
host.initializeLocalImports();
// ★ 把 /play 中继的真实转发字节速率推给渲染层（播放器「缓存中」实时网速）
const pushSpeed = (kbs: number): void => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('net:speed', kbs);
  }
};
proxy.onSpeed = pushSpeed;
torrent.onSpeed = pushSpeed;
proxy.onSpiderProxy = (port) => host.pinSpiderProxy(port);
proxy.onPythonProxy = (key, params) => host.pythonProxy(key, params);
proxy.bt = torrent;

function isDev(): boolean {
  return !app.isPackaged && process.env.NODE_ENV !== 'production';
}

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-dev-shm-usage');

app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_e, details) => {
    fileLogger.w(`renderer-gone wc=${contents.id} reason=${details.reason} exitCode=${details.exitCode}`);
  });
  contents.on('unresponsive', () => fileLogger.w(`renderer-unresponsive wc=${contents.id}`));
});
app.on('child-process-gone', (_event, details) => {
  fileLogger.w(`child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
});

function createWindow(): void {
  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0c10' : '#dce4ec',
    title: 'Win-Box',
    frame: false,
    autoHideMenuBar: true,
    icon: app.isPackaged ? undefined : join(__dirname, '..', '..', 'build', 'icon.png'),
    ...(process.platform === 'win32' ? { backgroundMaterial: 'mica' as const } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
  mainWindow = new BrowserWindow(winOpts);

  const setCorner = (round: boolean) => {
    if (mainWindow && !mainWindow.isDestroyed()) applyWindowCorner(mainWindow, round);
  };
  const refreshContent = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        const { webContents } = mainWindow;
        if (!webContents.isDestroyed()) webContents.invalidate();
      } catch {
        /* ignore */
      }
    }
  };
  mainWindow.on('maximize', () => { setCorner(false); refreshContent(); });
  mainWindow.on('unmaximize', () => { setCorner(true); refreshContent(); });

  if (isDev()) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // ★ 2026-09-30 数据目录（安装目录/data；老用户自动迁移 + 清理旧 C 盘目录）——排障第一现场
  try {
    const m = dataDirReport.migration;
    const migDesc = m
      ? `迁移=${m.status}${m.files ? `（${m.files} 文件 / ${(m.bytes / 1024 / 1024).toFixed(1)}MB）` : ''}${m.skipped ? `，跳过可重建缓存 ${m.skipped} 项` : ''}${m.status === 'moved' ? '（整目录移动）' : ''}${m.cleanedLegacy ? '，旧目录已清理' : ''}${m.error ? `，注意：${m.error}` : ''}`
      : '迁移=无旧数据';
    if (dataDirReport.mode === 'fallback') {
      fileLogger.w(
        `数据目录: ${dataDirReport.target}（回退，计划目录 ${dataDirReport.planned}）：${dataDirReport.reason || ''}`,
      );
    } else {
      fileLogger.i(`数据目录: ${dataDirReport.target}（模式 ${dataDirReport.mode}；${migDesc}）`);
    }
  } catch {
    /* ignore */
  }

  // 启动即记录资源根定位结果
  try {
    const { resourcesDir, resourcesDirDebug } = await import('./util/paths');
    const dir = resourcesDir();
    const ok = existsSync(join(dir, 'jvm', 'jre', 'bin', 'java.exe'));
    fileLogger.i(`资源根: ${dir} | java.exe: ${ok ? 'OK' : '缺失'}`);
    if (!ok) fileLogger.w('资源候选路径探测:\n' + resourcesDirDebug());
  } catch (e) {
    fileLogger.w('资源根探测失败: ' + (e instanceof Error ? e.message : String(e)));
  }

  fileLogger.i(`build: 20261012.1 release-${app.getVersion()}`);

  try {
    await proxy.start();
  } catch {
    fileLogger.w('本地代理启动失败，直播归一化可能受影响');
  }
  try {
    const { initProxySettings } = await import('./net/proxy');
    const { userDataDir } = await import('./util/paths');
    initProxySettings(join(userDataDir(), 'proxy.json'));
  } catch (e) {
    fileLogger.w('代理设置初始化失败：' + (e as Error).message);
  }
  try {
    const { initPlayDiag } = await import('./util/playDiag');
    const { userDataDir } = await import('./util/paths');
    initPlayDiag({
      logDir: () => join(userDataDir(), 'logs'),
      log: (m: string) => fileLogger.i(m),
    });
  } catch (e) {
    fileLogger.w('播放诊断初始化失败：' + (e as Error).message);
  }
  registerIpc(host, dav, dlna, updater, localPkgs);

  bindLiveImporter((srcPath, opts) => importLiveFileFromPath(host, srcPath, opts));
  registerLiveSubscriptionIpc();

  // ★ 2026-11-10（用户要求）：启动后延迟 10 秒检查网络 py 源是否有更新。
  setTimeout(() => {
    void host.checkPyUpdates().catch((e) => fileLogger.w('py 更新检查失败：' + (e as Error).message));
  }, 10_000);

  bossKey.start(() => {
    const ws: BrowserWindow[] = [];
    if (mainWindow && !mainWindow.isDestroyed()) ws.push(mainWindow);
    const pw = playerWindow();
    if (pw) ws.push(pw);
    return ws;
  });
  bossKey.apply();
  onPlayerWindowClosed(() => {
    void host.quarkDeletePending().catch(() => undefined);
  });
  void host.quarkDeletePending().catch(() => undefined);
  createWindow();

  // ★ 2026-11-13（用户要求「软件开启就校验网络直播源」）：窗口创建后 300ms 开始校验，
  //   不阻塞首屏；有变化 → 主进程重新导入 + 广播 payload，LivePage 收到后做精细 diff
  //   （名字变了只刷新 UI、URL 变了重播、频道没了保留旧地址继续播）。
  setTimeout(() => {
    void checkAndUpdateSubscriptions()
      .then((r) => {
        if (r.updated > 0 || r.failed > 0) {
          fileLogger.i(`[LiveSub] 启动自动检查：更新 ${r.updated} · 跳过 ${r.skipped} · 失败 ${r.failed}`);
        }
      })
      .catch((e) => fileLogger.w(`[LiveSub] 启动自动检查异常：${(e as Error).message}`));
  }, 300);

  void host.maybeAutoRefreshSubscriptions();
  try { host.syncDriveFiles(); } catch { /* 同步失败不影响启动 */ }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  proxy.stop();
  if (process.platform !== 'darwin') app.quit();
});

let quitCleanupStarted = false;
app.on('will-quit', (event) => {
  if (!quitCleanupStarted) {
    quitCleanupStarted = true;
    event.preventDefault();
    void Promise.race([
      host.quarkDeletePending(),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]).finally(() => app.quit());
    return;
  }
  try {
    void host.quarkDeletePending();
  } catch {
    /* ignore */
  }
  try {
    host.dispose();
  } catch {
    /* ignore */
  }
  try {
    torrent.dispose();
  } catch {
    /* ignore */
  }
  try {
    proxy.stop();
  } catch {
    /* ignore */
  }
});

process.on('beforeExit', () => {
  try { host.dispose(); } catch { /* ignore */ }
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
