/**
 * Encrypted attachments for end-to-end encrypted rooms (Matrix spec, "Sending encrypted attachments", v2):
 * AES-CTR-256 with a random key and a 16-byte IV whose low 8 bytes (the counter) are zero,
 * SHA-256 of the ciphertext, key as a JWK; base64 fields are unpadded.
 */
import { createHash, randomBytes, webcrypto } from 'node:crypto';

export interface EncryptedFile {
  url?: string;
  key: { kty: 'oct'; key_ops: string[]; alg: 'A256CTR'; k: string; ext: true };
  iv: string;
  hashes: { sha256: string };
  v: 'v2';
}

const unpad = (s: string) => s.replace(/=+$/, '');
const fromB64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export async function encryptAttachment(plain: Uint8Array): Promise<{ ciphertext: Uint8Array; file: EncryptedFile }> {
  const raw = randomBytes(32);
  const iv = Buffer.concat([randomBytes(8), Buffer.alloc(8)]);
  const key = await webcrypto.subtle.importKey('raw', raw, { name: 'AES-CTR' }, true, ['encrypt', 'decrypt']);
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, new Uint8Array(plain)));
  return {
    ciphertext,
    file: {
      key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: unpad(raw.toString('base64url')), ext: true },
      iv: unpad(iv.toString('base64')),
      hashes: { sha256: unpad(createHash('sha256').update(ciphertext).digest('base64')) },
      v: 'v2',
    },
  };
}

export async function decryptAttachment(ciphertext: Uint8Array, file: Pick<EncryptedFile, 'key' | 'iv' | 'hashes'>): Promise<Uint8Array> {
  const expected = file.hashes?.sha256;
  if (!expected || unpad(createHash('sha256').update(ciphertext).digest('base64')) !== unpad(expected)) {
    throw new Error('encrypted attachment: sha256 hash mismatch (corrupted or tampered file)');
  }
  const key = await webcrypto.subtle.importKey('raw', fromB64(file.key.k), { name: 'AES-CTR' }, false, ['decrypt']);
  return new Uint8Array(await webcrypto.subtle.decrypt({ name: "AES-CTR", counter: fromB64(file.iv), length: 64 }, key, new Uint8Array(ciphertext)));
}
