import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Link } from 'react-router-dom'
import { LinkProvider, type LinkComponentProps } from '@cloudflare/kumo/utils'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/queryClient'
import App from './App'
import '@fontsource-variable/inter/wght.css'
import './styles.css'
import './i18n' // i18next init (en + zh locales)

const RouterLink = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(({ href, ...props }, ref) => (
  <Link ref={ref} to={href ?? '/'} {...props} />
))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <LinkProvider component={RouterLink}><App /></LinkProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
