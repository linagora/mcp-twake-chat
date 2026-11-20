import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { stopWhenStdinEnds } from '../src/stdin-end.js';

describe('stopWhenStdinEnds', () => {
  it('stops once the client closes stdin', async () => {
    const stdin = new PassThrough();
    let stopped = 0;
    stopWhenStdinEnds(stdin, () => void stopped++);
    stdin.resume();
    stdin.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(1);
  });

  it('stops at once when stdin has already ended', async () => {
    const stdin = new PassThrough();
    stdin.resume();
    stdin.end();
    await new Promise((resolve) => stdin.once('end', resolve));
    let stopped = 0;
    stopWhenStdinEnds(stdin, () => void stopped++);
    expect(stopped).toBe(1);
  });
});
