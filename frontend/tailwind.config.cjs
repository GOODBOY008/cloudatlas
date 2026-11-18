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
        brand: token('brand'),
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
      borderRadius: { sm: '0.125rem', DEFAULT: '0.25rem', md: '0.25rem', lg: '0.375rem', xl: '0.375rem', '2xl': '0.5rem' },
      boxShadow: {
        panel: 'none',
        popover: '0 4px 16px rgb(18 22 28 / 0.12)',
      },
    },
  },
  plugins: [],
}
