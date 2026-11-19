import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

export type CoordinationEvent =
  | { type: 'api_key_revoked'; keyId: string }
  | { type: 'routing_changed' }
  | {
      type: 'cooldown';
      accountId: string;
      reason: 'rate_limited' | 'auth_failed' | 'failing';
      seconds: number;
    };

/**
 * Cross-instance notifications over Redis pub/sub. Publishing is fire-and-forget and nothing on
 * the request path ever waits for Redis: each instance applies events to its own in-memory state.
 * If Redis is unavailable, instances keep working independently (as in a single-instance pilot).
 */
export interface CoordinationBus {
  publish(event: CoordinationEvent): void;
  subscribe(handler: (event: CoordinationEvent) => void): void;
  close(): Promise<void>;
}

const CHANNEL = 'arc:events:v1';

export class RedisBus implements CoordinationBus {
  readonly instanceId = randomUUID();
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly handlers: Array<(e: CoordinationEvent) => void> = [];

  constructor(redisUrl: string) {
    const opts = {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
    };
    this.pub = new Redis(redisUrl, opts);
    // The subscriber connection must queue its SUBSCRIBE until connected.
    this.sub = new Redis(redisUrl, {
      ...opts,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
    this.pub.on('error', () => undefined);
    this.sub.on('error', () => undefined);
    this.sub.on('message', (_channel, raw) => {
      let msg: { from?: string; event?: CoordinationEvent };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg.event || msg.from === this.instanceId) return;
      for (const h of this.handlers) {
        try {
          h(msg.event);
        } catch {
          /* a bad handler must not break the bus */
        }
      }
    });
    void this.sub.subscribe(CHANNEL).catch(() => undefined);
  }

  /** Resolves once the subscription is active (used by tests and startup logs). */
  async ready(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.sub.status === 'ready' && this.pub.status === 'ready') {
        const n = (await this.pub.pubsub('NUMSUB', CHANNEL).catch(() => [CHANNEL, 0])) as [
          string,
          number,
        ];
        if (Number(n[1]) > 0) return true;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  publish(event: CoordinationEvent): void {
    if (this.pub.status !== 'ready') return;
    this.pub
      .publish(CHANNEL, JSON.stringify({ from: this.instanceId, event }))
      .catch(() => undefined);
  }

  subscribe(handler: (event: CoordinationEvent) => void): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.sub.quit(), this.pub.quit()]);
  }
}

/** Single-process stand-in (no Redis). */
export class LocalBus implements CoordinationBus {
  publish(): void {}
  subscribe(): void {}
  async close(): Promise<void> {}
}
