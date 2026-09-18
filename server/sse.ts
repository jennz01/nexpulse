import type { SSEStreamingApi } from 'hono/streaming';
import type { SseMessage } from '../shared/types';

export class SseHub {
  private clients = new Set<SSEStreamingApi>();

  add(stream: SSEStreamingApi): void { this.clients.add(stream); }
  remove(stream: SSEStreamingApi): void { this.clients.delete(stream); }
  get size(): number { return this.clients.size; }

  async broadcast(msg: SseMessage): Promise<void> {
    const data = JSON.stringify(msg);
    await Promise.all(
      [...this.clients].map(async (stream) => {
        try {
          await stream.writeSSE({ event: 'update', data });
        } catch {
          this.remove(stream);
        }
      }),
    );
  }
}
