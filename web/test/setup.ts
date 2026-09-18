import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Server tests share this preload. Happy DOM would also replace Bun's fetch family with its own
// implementation; keep the native ones so server tests (Response.json, streamed bodies) still run against Bun.
if (typeof document === 'undefined') {
  const native = { fetch, Response, Request, Headers, URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder, ReadableStream, WritableStream, TransformStream, Blob };
  GlobalRegistrator.register();
  Object.assign(globalThis, native);
}
