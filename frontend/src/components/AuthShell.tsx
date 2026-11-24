import type { ReactNode } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import Brand from './Brand'
import LanguageToggle from './LanguageToggle'
import { useThemeStore } from '../store/themeStore'

export default function AuthShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { theme, toggleTheme } = useThemeStore()
  return (
    <div className="auth-layout">
      <header className="auth-header">
        <Brand />
        <div className="flex items-center gap-1">
          <LanguageToggle />
          <Button variant="ghost" shape="square" onClick={toggleTheme}
            aria-label={t(theme === 'dark' ? 'header.themeToLight' : 'header.themeToDark')}>
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </Button>
        </div>
      </header>
      <main className="auth-form-area">{children}</main>
    </div>
  )
}
