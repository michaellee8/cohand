import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhTW from './locales/zh-TW.json';
import zhCN from './locales/zh-CN.json';

export type SupportedLocale = 'en' | 'zh-TW' | 'zh-CN';

export function resolveLocale(raw: string): SupportedLocale {
  const lower = raw.toLowerCase();
  // Traditional Chinese: TW, HK, MO regions + Hant script
  if (
    lower.startsWith('zh-tw') ||
    lower.startsWith('zh-hk') ||
    lower.startsWith('zh-mo') ||
    lower.startsWith('zh-hant')
  ) return 'zh-TW';
  // Simplified Chinese: CN, SG, Hans script, bare zh
  if (lower.startsWith('zh')) return 'zh-CN';
  return 'en';
}

// Init synchronously with English
i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    'zh-TW': { translation: zhTW },
    'zh-CN': { translation: zhCN },
  },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

// Async: read stored language and switch
(async () => {
  try {
    const result = await chrome.storage.local.get('settings');
    const settings = result.settings;
    if (settings?.language && ['en', 'zh-TW', 'zh-CN'].includes(settings.language)) {
      await i18next.changeLanguage(settings.language);
    } else {
      // Detect from browser
      const detected = resolveLocale(navigator.language);
      await i18next.changeLanguage(detected);
    }
  } catch {
    // Extension context may not be available in tests; stay on 'en'
  }
})();

export default i18next;
