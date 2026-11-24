/** Theme values live in src/styles.css so every page uses the same light/dark tokens. */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: token('canvas'),
        surface: 'var(--color-kumo-base)',
        subtle: 'var(--color-kumo-elevated)',
        emphasis: 'var(--color-kumo-fill)',
        primary: 'var(--text-color-kumo-default)',
        secondary: token('text-secondary'),
        muted: 'var(--text-color-kumo-subtle)',
        edge: 'var(--color-kumo-hairline)',
        strong: 'var(--color-kumo-interact)',
        accent: {
          DEFAULT: token('accent'),
          hover: token('accent-hover'),
          soft: token('accent-soft'),
        },
        brand: 'var(--text-color-kumo-brand)',
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
      boxShadow: {
        panel: 'none',
        popover: '0 4px 16px rgb(18 22 28 / 0.12)',
      },
    },
  },
  plugins: [],
}
