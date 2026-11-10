// src/main/player/adKeywordSettings.ts
// ★ 2026-11-10（用户要求）：广告关键词设置 —— 允许用户在配置页「播放 · m3u8 去广告」里
//   增删改「赌场/娱乐城/…」等关键词。持久化到 <userData>/ad-keywords.json。
import { JsonStore } from '../store/JsonStore';
import { join } from 'node:path';
import { userDataDir } from '../util/paths';
import { fileLogger } from '../util/logger';

export interface AdKeywordSettings {
  /** 强关键词：URL path segment / domain label 完整命中即拦截；M3U8 清单里命中即清洗 */
  strong: string[];
  /** 弱关键词：只在 M3U8 清单清洗里用（需 EXTINF 上下文，避免误伤正片） */
  weak: string[];
}

export const DEFAULT_AD_KEYWORDS: AdKeywordSettings = {
  strong: ['赌场', '娱乐城', '博彩', 'casino', 'gambling', 'bet365'],
  weak: ['poker', '葡京', '太阳城', '威尼斯人', '银河娱乐', '网赌'],
};

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = s.toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

function normalize(s: Partial<AdKeywordSettings> | null): AdKeywordSettings {
  const strong = Array.isArray(s?.strong)
    ? s!.strong.map((x) => String(x || '').trim()).filter(Boolean)
    : [...DEFAULT_AD_KEYWORDS.strong];
  const weak = Array.isArray(s?.weak)
    ? s!.weak.map((x) => String(x || '').trim()).filter(Boolean)
    : [...DEFAULT_AD_KEYWORDS.weak];
  return { strong: dedupe(strong), weak: dedupe(weak) };
}

class AdKeywordStore {
  private store: JsonStore;
  private current: AdKeywordSettings;

  constructor() {
    this.store = new JsonStore(join(userDataDir(), 'ad-keywords.json'));
    const saved = this.store.getObject<Partial<AdKeywordSettings> | null>('settings', null);
    this.current = normalize(saved);
  }

  get settings(): AdKeywordSettings {
    return this.current;
  }

  update(patch: Partial<AdKeywordSettings>): AdKeywordSettings {
    this.current = normalize({ ...this.current, ...patch });
    this.store.setObject('settings', this.current);
    this.store.flush();
    fileLogger.i(`ad-keywords 已保存：强 ${this.current.strong.length} / 弱 ${this.current.weak.length}`);
    return this.current;
  }
}

export const adKeywordSettings = new AdKeywordStore();
