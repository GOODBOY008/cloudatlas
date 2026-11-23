import i18n, { type BackendModule } from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/enShell'
import zh from './locales/zhShell'

export const SUPPORTED_LANGUAGES = ['en', 'zh'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]
export const WORKSPACE_NAMESPACE = 'workspace'

const STORAGE_KEY = 'cloudatlas-language'

export function isSupportedLanguage(value: string | null): value is SupportedLanguage {
  return SUPPORTED_LANGUAGES.includes(value as SupportedLanguage)
}

/** Persisted language preference (mirrors the themeStore localStorage pattern). */
export function getStoredLanguage(): SupportedLanguage {
  if (typeof window === 'undefined') return 'en'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  return isSupportedLanguage(stored) ? stored : 'en'
}

export function setStoredLanguage(lang: SupportedLanguage) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, lang)
}

export async function changeAppLanguage(language: SupportedLanguage) {
  await i18n.changeLanguage(language)
  if (i18n.language === language) setStoredLanguage(language)
}

/** Keep the <html lang> attribute in sync with the active language. */
export function syncHtmlLang(lang: SupportedLanguage) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = lang
}

const workspaceMessages = {
  en: () => import('./locales/en'),
  zh: () => import('./locales/zh'),
}

const workspaceBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(language, namespace, callback) {
    if (namespace !== WORKSPACE_NAMESPACE || !isSupportedLanguage(language)) {
      callback(null, {})
      return
    }
    void workspaceMessages[language]().then(
      ({ workspace }) => callback(null, workspace),
      (error: unknown) => callback(String(error), false),
    )
  },
}

i18n.use(workspaceBackend).use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  ns: ['translation'],
  fallbackNS: WORKSPACE_NAMESPACE,
  partialBundledLanguages: true,
  lng: getStoredLanguage(),
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes
  },
  returnNull: false,
})

// Keep <html lang> in sync on every language change (not just init).
i18n.on('languageChanged', (lng) => {
  syncHtmlLang(isSupportedLanguage(lng) ? lng : 'en')
})

syncHtmlLang(getStoredLanguage())

export default i18n
