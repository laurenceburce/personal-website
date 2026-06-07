/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        ink:            'var(--ink)',
        muted:          'var(--muted)',
        subtle:         'var(--subtle)',
        accent:         'var(--accent)',
        'accent-alt':   'var(--accent-alt)',
        'accent-strong':'var(--accent-strong)',
        surface:        'var(--surface)',
        'surface-solid':'var(--surface-solid)',
        'glass-border': 'var(--glass-border)',
      },
      fontFamily: {
        sans:  ['var(--font-manrope)',          'Segoe UI', 'sans-serif'],
        serif: ['var(--font-dm-serif-display)', 'Georgia',  'serif'],
      },
      boxShadow: {
        card:        'var(--shadow-card)',
        'card-hover':'var(--shadow-card-hover)',
        soft:        'var(--shadow-soft)',
        header:      'var(--shadow-header)',
      },
      borderRadius: {
        'theme-lg': 'var(--radius-lg)',
        'theme-md': 'var(--radius-md)',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        expo:   'cubic-bezier(0.16, 1, 0.3, 1)',
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      animation: {
        'badge-pulse':    'badge-pulse 2.4s ease infinite',
        'auth-btn-pulse': 'auth-btn-pulse 1s ease-in-out infinite',
      },
      backdropBlur: {
        10: '10px',
        14: '14px',
      },
      maxWidth: {
        content: '1240px',
      },
      spacing: {
        '18':  '4.5rem',
        '22':  '5.5rem',
        '26':  '6.5rem',
        '30':  '7.5rem',
      },
    },
  },
  plugins: [],
};
