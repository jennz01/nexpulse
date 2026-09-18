import { describe, expect, test } from 'bun:test';
import { base64url, importPrivateKey, pemToDer, signJwt } from './jwt';

async function toPem(key: CryptoKey): Promise<string> {
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key));
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}
function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

describe('base64url', () => {
  test('encodes without padding using the url alphabet', () => {
    expect(base64url('hi')).toBe('aGk');
    expect(base64url(new Uint8Array([251, 255]))).toBe('-_8');
  });
});

describe('pemToDer', () => {
  test('strips armour and whitespace', () => {
    expect([...pemToDer('-----BEGIN PRIVATE KEY-----\nAAEC\nAw==\n-----END PRIVATE KEY-----')]).toEqual([0, 1, 2, 3]);
  });
});

describe('signJwt', () => {
  test('ES256 token verifies with the public key and carries kid', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const key = await importPrivateKey(await toPem(pair.privateKey), 'ES256');
    const jwt = await signJwt({ alg: 'ES256', header: { kid: 'KEY1' }, payload: { iss: 'issuer', aud: 'appstoreconnect-v1' }, key });
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'KEY1' });
    expect(JSON.parse(new TextDecoder().decode(fromB64url(p))).aud).toBe('appstoreconnect-v1');
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, fromB64url(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });

  test('RS256 token verifies with the public key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const key = await importPrivateKey(await toPem(pair.privateKey), 'RS256');
    const jwt = await signJwt({ alg: 'RS256', payload: { scope: 'x' }, key });
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, pair.publicKey, fromB64url(s) as BufferSource, new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });
});
