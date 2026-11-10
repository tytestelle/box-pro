// src/main/player/adKeywordSettings.ts
// ★ 2026-11-10（用户要求）：广告关键词设置 —— 允许用户在配置页「播放 · m3u8 去广告」里
//   增删改「赌场/娱乐城/…」等关键词。持久化到 <userData>/ad-keywords.json。
//   注意：默认值放在 m3u8Purify.ts 的 DEFAULT_AD_KEYWORDS_*，这里是**用户覆盖后的值**。
import { JsonStore } from '../store/JsonStore';
import { join } from 'node:path';
import { userDataDir } from '../util/paths';
import { fileLogger } from '../util/logger';
import {
  DEFAULT_AD_KEYWORDS_STRONG,
  DEFAULT_AD_KEYWORDS_WEAK,
} from '../../engine/util/m3u8Purify';

export interface AdKeywordSettings {
  /** 强关键词：URL path segment / domain label 完整命中即拦截；M3U8 清单里命中即清洗 */
  strong: string[];
  /** 弱关键词：只在 M3U8 清单清洗里用（需 EXTINF 上下文，避免误伤正片） */
  weak: string[];
}

/** 默认值（与 m3u8Purify.ts 的 DEFAULT_AD_KEYWORDS_* 保持一致；用户清空时回落到这里） */
export const DEFAULT_AD_KEYWORDS: AdKeywordSettings = {
  strong: [...DEFAULT_AD_KEYWORDS_STRONG],
  weak: [...DEFAULT_AD_KEYWORDS_WEAK],
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
  // ★ 注意语义：`strong`/`weak` 传 `undefined` = 用默认；传 `[]` = 用户显式清空（保留空数组，
  //   这样「关掉所有内置关键词」也能生效，不会因为空数组被当成「未设置」又回落到默认）。
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
