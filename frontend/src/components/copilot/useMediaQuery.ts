import { useEffect, useState } from 'react'

/**
 * matchMedia hook. jsdom has no matchMedia implementation — returns `fallback`
 * (defaults to desktop) so component tests exercise the desktop layout.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return fallback
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    mql.addEventListener('change', onChange)
    setMatches(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** Desktop = Tailwind `lg` breakpoint (1024 px). */
export function useIsDesktop() {
  return useMediaQuery('(min-width: 1024px)')
}
