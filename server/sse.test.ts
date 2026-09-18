import { expect, mock, test } from 'bun:test';
import { SseHub } from './sse';
import type { SSEStreamingApi } from 'hono/streaming';

function fakeStream(fail = false) {
  const writeSSE = mock(async (_message: { event?: string; data: string }) => { if (fail) throw new Error('closed'); });
  return { stream: { writeSSE } as unknown as SSEStreamingApi, writeSSE };
}

test('broadcast writes the same JSON to every client and drops failing ones', async () => {
  const hub = new SseHub();
  const a = fakeStream();
  const b = fakeStream(true);
  hub.add(a.stream);
  hub.add(b.stream);
  await hub.broadcast({ source: 'github', state: { snapshot: null, fetchedAt: 1, error: null, errorAt: null, disabled: null }, events: [] });
  expect(a.writeSSE).toHaveBeenCalledTimes(1);
  const arg = a.writeSSE.mock.calls[0]?.[0] as { event: string; data: string };
  expect(arg.event).toBe('update');
  expect(JSON.parse(arg.data).source).toBe('github');
  expect(hub.size).toBe(1);
});
