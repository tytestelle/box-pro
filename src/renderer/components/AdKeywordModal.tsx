// src/renderer/components/AdKeywordModal.tsx
// ★ 2026-11-10（用户要求）：广告关键词编辑器 —— 配置页「m3u8 去广告 · 规则」按钮打开。
//   两个列表（强/弱），每项可改文本、可删；底部输入框可追加。保存后立即生效（无需重启）。
import { useEffect, useState } from 'react';
import { client } from '../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
}

const STRONG_HINT = '强关键词：URL 路径段 / 域名标签**完整命中**即拦截（如 casino.example.com）。也用于 M3U8 清单清洗。';
const WEAK_HINT = '弱关键词：只在 M3U8 清单清洗里用（需要 EXTINF 上下文，避免误伤正片）。';

function KeywordList({
  title,
  hint,
  items,
  onChange,
}: {
  title: string;
  hint: string;
  items: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = (): void => {
    const v = draft.trim();
    if (!v) return;
    if (items.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setDraft('');
      return;
    }
    onChange([...items, v]);
    setDraft('');
  };
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{title}（{items.length}）</div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 8, lineHeight: 1.6 }}>{hint}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
        {items.length === 0 && (
          <div className="muted" style={{ fontSize: 11 }}>（空）</div>
        )}
        {items.map((kw, i) => (
          <div key={`${kw}-${i}`} className="row" style={{ gap: 6, alignItems: 'center' }}>
            <input
              style={{ flex: 1 }}
              value={kw}
              onChange={(e) => {
                const next = items.slice();
                next[i] = e.target.value;
                onChange(next);
              }}
            />
            <button
              className="linkbtn danger"
              title="删除该关键词"
              onClick={() => {
                const next = items.slice();
                next.splice(i, 1);
                onChange(next);
              }}
            >
              删
            </button>
          </div>
        ))}
      </div>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <input
          style={{ flex: 1 }}
          placeholder="输入新关键词，回车或点「添加」"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        />
        <button className="primary" disabled={!draft.trim()} onClick={add}>添加</button>
      </div>
    </div>
  );
}

export default function AdKeywordModal({ open, onClose }: Props) {
  const [strong, setStrong] = useState<string[]>([]);
  const [weak, setWeak] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    client.adKeywordsGet()
      .then((s) => { setStrong(s.strong); setWeak(s.weak); })
      .catch((e) => setMsg({ text: (e as Error).message, kind: 'err' }));
  }, [open]);

  if (!open) return null;

  const save = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await client.adKeywordsSet({ strong, weak });
      setStrong(r.strong);
      setWeak(r.weak);
      setMsg({ text: '✓ 已保存，立即生效', kind: 'ok' });
    } catch (e) {
      setMsg({ text: `保存失败：${(e as Error).message}`, kind: 'err' });
    } finally {
      setBusy(false);
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
        style={{ width: 620, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto', padding: 20, background: 'var(--bg-elev)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>广告关键词</h3>
        <div className="muted" style={{ fontSize: 11, marginBottom: 14 }}>
          修改后立即生效；URL 级拦截始终生效，M3U8 清单清洗需打开「m3u8 去广告」开关。
        </div>

        <KeywordList title="强关键词" hint={STRONG_HINT} items={strong} onChange={setStrong} />
        <KeywordList title="弱关键词" hint={WEAK_HINT} items={weak} onChange={setWeak} />

        {msg && (
          <div className={msg.kind === 'err' ? 'err' : 'status'} style={{ fontSize: 12, marginBottom: 10 }}>
            {msg.text}
          </div>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button disabled={busy} onClick={onClose}>关闭</button>
          <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}
