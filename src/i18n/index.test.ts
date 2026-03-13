import { describe, it, expect, beforeEach } from 'vitest';
import en from './locales/en.json';
import zhTW from './locales/zh-TW.json';
import zhCN from './locales/zh-CN.json';

// Install minimal chrome mock so i18n module can be imported without errors
function installChromeMock() {
  const store: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const keyList = typeof keys === 'string' ? [keys] : keys;
          const result: Record<string, unknown> = {};
          for (const k of keyList) {
            if (k in store) result[k] = store[k];
          }
          return result;
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        },
      },
    },
    runtime: {
      sendMessage: async () => ({}),
    },
  };
}

beforeEach(() => {
  installChromeMock();
});

describe('resolveLocale', () => {
  // Import lazily to ensure chrome mock is in place
  const getResolveLocale = async () => {
    const mod = await import('./index');
    return mod.resolveLocale;
  };

  it('maps zh-TW to zh-TW', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('zh-TW')).toBe('zh-TW');
  });

  it('maps zh-Hant to zh-TW', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('zh-Hant')).toBe('zh-TW');
  });

  it('maps zh-Hant-TW to zh-TW', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('zh-Hant-TW')).toBe('zh-TW');
  });

  it('maps zh-tw (lowercase) to zh-TW', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('zh-tw')).toBe('zh-TW');
  });

  it('maps zh-HK to zh-TW (Traditional)', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('zh-HK')).toBe('zh-TW');
  });

  it('maps zh-MO to zh-TW (Traditional)', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('zh-MO')).toBe('zh-TW');
  });

  it('maps zh-Hant-HK to zh-TW', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('zh-Hant-HK')).toBe('zh-TW');
  });

  it('maps zh-CN to zh-CN', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
  });

  it('maps zh-Hans to zh-CN', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('zh-Hans')).toBe('zh-CN');
  });

  it('maps zh (bare) to zh-CN', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('zh')).toBe('zh-CN');
  });

  it('maps en to en', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('en')).toBe('en');
  });

  it('maps en-US to en', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('en-US')).toBe('en');
  });

  it('maps unknown locale ja to en', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('ja')).toBe('en');
  });

  it('maps fr to en', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('fr')).toBe('en');
  });

  it('maps empty string to en', async () => {
    const resolveLocale = await getResolveLocale();
    expect(resolveLocale('')).toBe('en');
  });
});

describe('translation completeness', () => {
  const enKeys = Object.keys(en).sort();
  const zhTWKeys = Object.keys(zhTW).sort();
  const zhCNKeys = Object.keys(zhCN).sort();

  it('zh-TW has all keys from en', () => {
    const missingInZhTW = enKeys.filter(k => !zhTWKeys.includes(k));
    expect(missingInZhTW).toEqual([]);
  });

  it('zh-CN has all keys from en', () => {
    const missingInZhCN = enKeys.filter(k => !zhCNKeys.includes(k));
    expect(missingInZhCN).toEqual([]);
  });

  it('zh-TW has no extra keys beyond en', () => {
    const extraInZhTW = zhTWKeys.filter(k => !enKeys.includes(k));
    expect(extraInZhTW).toEqual([]);
  });

  it('zh-CN has no extra keys beyond en', () => {
    const extraInZhCN = zhCNKeys.filter(k => !enKeys.includes(k));
    expect(extraInZhCN).toEqual([]);
  });

  it('all locale files have the same number of keys', () => {
    expect(enKeys.length).toBe(zhTWKeys.length);
    expect(enKeys.length).toBe(zhCNKeys.length);
  });

  it('no values are empty strings', () => {
    const emptyInEn = enKeys.filter(k => (en as Record<string, string>)[k] === '');
    const emptyInZhTW = zhTWKeys.filter(k => (zhTW as Record<string, string>)[k] === '');
    const emptyInZhCN = zhCNKeys.filter(k => (zhCN as Record<string, string>)[k] === '');
    expect(emptyInEn).toEqual([]);
    expect(emptyInZhTW).toEqual([]);
    expect(emptyInZhCN).toEqual([]);
  });
});

describe('i18next init', () => {
  it('initializes and t() returns English by default', async () => {
    const mod = await import('./index');
    const i18n = mod.default;
    expect(i18n.language).toBe('en');
    expect(i18n.t('tabs.chat')).toBe('Chat');
  });

  it('changeLanguage switches translations', async () => {
    const mod = await import('./index');
    const i18n = mod.default;
    await i18n.changeLanguage('zh-TW');
    expect(i18n.t('tabs.chat')).toBe('\u804A\u5929');
    await i18n.changeLanguage('zh-CN');
    expect(i18n.t('tabs.chat')).toBe('\u804A\u5929');
    // Restore
    await i18n.changeLanguage('en');
    expect(i18n.t('tabs.chat')).toBe('Chat');
  });
});
