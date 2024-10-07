import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [],
  test: {
    alias: {},
    environment: 'jsdom',
    includeSource: ['**/*.{js,ts,jsx,tsx}'],
    setupFiles: './vitest.setup.mts',
  },
});
