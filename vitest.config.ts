import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'references', 'e2e', '.output'],
    ssr: {
      noExternal: ['@mariozechner/pi-ai'],
    },
  },
});
