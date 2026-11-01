import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptAttachment, encryptAttachment } from '../src/attachment.js';

const b64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

describe('encrypted attachments (Matrix v2, AES-CTR-256)', () => {
  it('produces a spec-shaped EncryptedFile and round-trips', async () => {
    const plain = new TextEncoder().encode('hello encrypted world'.repeat(100));
    const { ciphertext, file } = await encryptAttachment(plain);
    expect(file.v).toBe('v2');
    expect(file.key).toMatchObject({ kty: 'oct', alg: 'A256CTR', ext: true, key_ops: ['encrypt', 'decrypt'] });
    expect(b64u(file.key.k)).toHaveLength(32);
    const iv = Buffer.from(file.iv, 'base64');
    expect(iv).toHaveLength(16);
    expect([...iv.subarray(8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]); // counter half zeroed
    expect(file.iv).not.toMatch(/=/); // unpadded base64
    expect(file.hashes.sha256).toBe(createHash('sha256').update(ciphertext).digest('base64').replace(/=+$/, ''));
    expect(Buffer.from(ciphertext).equals(Buffer.from(plain))).toBe(false);
    expect(Buffer.from(await decryptAttachment(ciphertext, file)).toString()).toBe('hello encrypted world'.repeat(100));
  });

  it('refuses a ciphertext whose hash does not match', async () => {
    const { ciphertext, file } = await encryptAttachment(new Uint8Array([1, 2, 3]));
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 1;
    await expect(decryptAttachment(tampered, file)).rejects.toThrow(/hash/);
  });
});
