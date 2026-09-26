import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['workspace/ui', { test: { name: 'scripts', include: ['scripts/*.test.mjs'] } }],
  },
});
