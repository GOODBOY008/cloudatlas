/** Theme values live in src/styles.css so every page uses the same light/dark tokens. */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: token('canvas'),
        surface: token('surface'),
        subtle: token('subtle'),
        emphasis: token('emphasis'),
        primary: token('text-primary'),
        secondary: token('text-secondary'),
        muted: token('text-muted'),
        edge: token('border'),
        strong: token('border-strong'),
        accent: {
          DEFAULT: token('accent'),
          hover: token('accent-hover'),
          soft: token('accent-soft'),
        },
        'on-accent': token('on-accent'),
        success: { DEFAULT: token('success'), solid: '#15803d' },
        warning: { DEFAULT: token('warning'), solid: '#a16207' },
        danger: { DEFAULT: token('danger'), solid: '#dc2626' },
        info: { DEFAULT: token('info'), solid: '#2563eb' },
        violet: { DEFAULT: token('violet'), solid: '#7c3aed' },
      },
      fontFamily: {
        sans: [
          'Inter Variable',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
      },
      borderRadius: { xl: '0.875rem', '2xl': '1.125rem' },
      boxShadow: {
        panel:
          '0 2px 4px rgb(15 23 42 / 0.02), 0 8px 24px rgb(15 23 42 / 0.025)',
        popover: '0 12px 48px rgb(15 23 42 / 0.16)',
      },
    },
  },
  plugins: [],
}
