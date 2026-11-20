import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

describe('VERSION', () => {
  it('is the version of package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('is never written by hand in the entry point (0.7.0 said 0.6.1)', () => {
    expect(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')).not.toMatch(/VERSION\s*=\s*'\d/);
  });
});
