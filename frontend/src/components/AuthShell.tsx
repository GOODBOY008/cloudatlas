import type { ReactNode } from 'react'
import {
  ArrowUpRight,
  Boxes,
  ChartNoAxesCombined,
  CircleCheck,
  Moon,
  Sun,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import Brand from './Brand'
import LanguageToggle from './LanguageToggle'
import { useThemeStore } from '../store/themeStore'

export default function AuthShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { theme, toggleTheme } = useThemeStore()
  const features = [
    {
      icon: ChartNoAxesCombined,
      title: 'design.authCost',
      body: 'design.authCostBody',
    },
    { icon: Boxes, title: 'design.authAssets', body: 'design.authAssetsBody' },
    {
      icon: CircleCheck,
      title: 'design.authAction',
      body: 'design.authActionBody',
    },
  ]
  return (
    <div className="auth-layout">
      <aside className="auth-story">
        <Brand />
        <div className="relative my-16 max-w-[440px]">
          <div
            aria-hidden="true"
            className="mb-9 flex h-14 w-14 items-center justify-center rounded-md border border-edge bg-surface text-brand"
          >
            <ArrowUpRight size={28} strokeWidth={1.5} />
          </div>
          <p className="mb-5 text-[11px] font-medium uppercase tracking-[0.17em] text-brand">
            {t('design.authEyebrow')}
          </p>
          <h2 className="text-[36px] font-semibold leading-tight tracking-[-1px] xl:text-[42px]">
            {t('design.authTitle')}
          </h2>
          <p className="mt-6 text-[15px] leading-relaxed text-secondary">
            {t('design.authBody')}
          </p>
          <div className="mt-12 space-y-6">
            {features.map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex items-start gap-3.5">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-edge text-brand">
                  <Icon size={16} strokeWidth={1.6} />
                </span>
                <div>
                  <h3 className="text-[13px] font-medium text-primary">
                    {t(title)}
                  </h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted">
                    {t(body)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-edge pt-5 text-[10px] text-muted">
          <span>CloudAtlas</span>
          <span>{t('design.allConnected')}</span>
        </div>
      </aside>
      <main className="auth-form-area">
        <div className="absolute right-6 top-6 flex items-center gap-2">
          <LanguageToggle />
          <button
            className="icon-button"
            onClick={toggleTheme}
            aria-label={t(
              theme === 'dark' ? 'header.themeToLight' : 'header.themeToDark',
            )}
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
        <div className="w-full max-w-[380px]">
          <div className="mb-12 lg:hidden">
            <Brand />
          </div>
          {children}
          <p className="mt-10 text-center text-[11px] text-muted">
            {t('design.secureWorkspace')}
          </p>
        </div>
      </main>
    </div>
  )
}
