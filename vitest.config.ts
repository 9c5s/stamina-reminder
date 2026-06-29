import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/durable-objects/**'],
    },
    reporters: ['default'],
    passWithNoTests: false,
  },
});
