export type JwtAlg = 'ES256' | 'RS256';

const ALGS = {
  ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' } as EcKeyImportParams, sign: { name: 'ECDSA', hash: 'SHA-256' } as EcdsaParams },
  RS256: { import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as RsaHashedImportParams, sign: { name: 'RSASSA-PKCS1-v1_5' } as Algorithm },
} as const;

export function base64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function importPrivateKey(pem: string, alg: JwtAlg): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pemToDer(pem) as BufferSource, ALGS[alg].import, false, ['sign']);
}

export async function signJwt(opts: { alg: JwtAlg; header?: Record<string, unknown>; payload: Record<string, unknown>; key: CryptoKey }): Promise<string> {
  const header = base64url(JSON.stringify({ alg: opts.alg, typ: 'JWT', ...opts.header }));
  const payload = base64url(JSON.stringify(opts.payload));
  const signature = await crypto.subtle.sign(ALGS[opts.alg].sign, opts.key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(signature)}`;
}
