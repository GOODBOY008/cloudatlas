import { describe, it, expect, beforeEach } from 'vitest'
import i18n, { getStoredLanguage, setStoredLanguage, isSupportedLanguage } from '../i18n'
import en from '../i18n/locales/en'
import zh from '../i18n/locales/zh'

describe('i18n', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('en and zh locales have identical key sets', () => {
    const enKeys = Object.keys(en).sort()
    const zhKeys = Object.keys(zh).sort()
    expect(zhKeys).toEqual(enKeys)
    expect(enKeys.length).toBeGreaterThan(100)
  })

  it('every translation value is non-empty in both locales', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim().length, `en:${key}`).toBeGreaterThan(0)
    }
    for (const [key, value] of Object.entries(zh)) {
      expect(value.trim().length, `zh:${key}`).toBeGreaterThan(0)
    }
  })

  it('resolves English by default', () => {
    expect(i18n.t('nav.dashboard')).toBe('Dashboard')
    expect(i18n.t('nav.expenses')).toBe('Cost Explorer')
    expect(i18n.t('common.logout')).toBe('Logout')
  })

  it('resolves Chinese after switching language', async () => {
    await i18n.changeLanguage('zh')
    expect(i18n.t('nav.dashboard')).toBe('仪表盘')
    expect(i18n.t('nav.expenses')).toBe('成本浏览器')
    expect(i18n.t('common.logout')).toBe('退出登录')
    expect(i18n.t('login.signIn')).toBe('登录')
    // restore for other tests
    await i18n.changeLanguage('en')
  })

  it('persists language preference to localStorage', () => {
    expect(getStoredLanguage()).toBe('en')
    setStoredLanguage('zh')
    expect(getStoredLanguage()).toBe('zh')
    expect(window.localStorage.getItem('cloudatlas-language')).toBe('zh')
    setStoredLanguage('en')
  })

  it('guards unsupported languages', () => {
    expect(isSupportedLanguage('en')).toBe(true)
    expect(isSupportedLanguage('zh')).toBe(true)
    expect(isSupportedLanguage('fr')).toBe(false)
    expect(isSupportedLanguage(null)).toBe(false)
  })

  it('syncs the html lang attribute', async () => {
    document.documentElement.lang = ''
    await i18n.changeLanguage('zh')
    expect(document.documentElement.lang).toBe('zh')
    await i18n.changeLanguage('en')
    expect(document.documentElement.lang).toBe('en')
  })
})
