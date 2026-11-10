// src/renderer/components/PyImportModal.tsx
// ★ 2026-11-10（用户要求）：.py 源导入弹窗 —— 本地文件 / 网络地址 两种方式。
//   本地：主进程弹文件选择器，复制到 imports/py/<key>/。
//   网络：主进程下载到 imports/py/net-<sha1>/<filename>.py，并记录 _meta.json 供启动时检查更新。
import { useEffect, useState } from 'react';

export interface PyImportResult {
  ok: boolean;
  key?: string;
  error?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** 导入本地 .py 文件（主进程弹出文件选择器） */
  onImportLocal: () => Promise<PyImportResult>;
  /** 导入网络 .py 文件（下载到 imports/py/<key>/ 并加入源） */
  onImportUrl: (url: string) => Promise<PyImportResult>;
}

export default function PyImportModal({ open, onClose, onImportLocal, onImportUrl }: Props) {
  const [busy, setBusy] = useState<'' | 'local' | 'url'>('');
  const [pyUrl, setPyUrl] = useState('');
  const [err, setErr] = useState('');
  const [okMsg, setOkMsg] = useState('');

  useEffect(() => {
    if (!open) {
      setBusy('');
      setPyUrl('');
      setErr('');
      setOkMsg('');
    }
  }, [open]);

  if (!open) return null;

  const handleLocal = async () => {
    setBusy('local'); setErr(''); setOkMsg('');
    try {
      const r = await onImportLocal();
      if (r.ok) setOkMsg(`已导入本地 .py 源：${r.key || ''}`);
      else if (r.error) setErr(r.error);
      // 用户取消：静默
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const handleUrl = async () => {
    const u = pyUrl.trim();
    if (!u) { setErr('请填写网络 .py 文件地址'); return; }
    setBusy('url'); setErr(''); setOkMsg('');
    try {
      const r = await onImportUrl(u);
      if (r.ok) {
        setOkMsg(`已导入网络 .py 源：${r.key || ''}`);
        setPyUrl('');
      } else if (r.error) {
        setErr(r.error);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        className="card"
        style={{ width: 540, maxWidth: '92vw', padding: 20, background: 'var(--bg-elev)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>导入 .py 源</h3>

        {/* 方式一：本地文件 */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>从本地文件</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 8, lineHeight: 1.6 }}>
            选择本机 .py 文件；主进程复制到安装目录 <code>imports/py/&lt;key&gt;/</code>。
            覆盖安装时由 <code>build/installer.nsh</code> 保留该目录。
          </div>
          <button className="primary" disabled={!!busy} onClick={() => void handleLocal()} style={{ minWidth: 170 }}>
            {busy === 'local' ? '导入中…' : '选择本地 .py 文件'}
          </button>
        </div>

        {/* 方式二：网络地址 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>从网络地址</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 8, lineHeight: 1.6 }}>
            下载到 <code>imports/py/net-&lt;sha1&gt;/</code>；每次启动会联网确认内容是否变化，
            有更新时自动重新下载，无更新保持原样。
          </div>
          <div className="row" style={{ gap: 8 }}>
            <input
              style={{ flex: 1, minWidth: 240 }}
              placeholder="https://example.com/spider.py"
              value={pyUrl}
              onChange={(e) => setPyUrl(e.target.value)}
              disabled={!!busy}
              onKeyDown={(e) => { if (e.key === 'Enter' && !busy && pyUrl.trim()) void handleUrl(); }}
            />
            <button className="primary" disabled={!!busy || !pyUrl.trim()} onClick={() => void handleUrl()}>
              {busy === 'url' ? '下载中…' : '下载并导入'}
            </button>
          </div>
        </div>

        {err && <div className="err" style={{ fontSize: 12, marginBottom: 10 }}>{err}</div>}
        {okMsg && <div className="status" style={{ fontSize: 12, marginBottom: 10 }}>✅ {okMsg}</div>}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
          <button disabled={!!busy} onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
