/**
 * A tiny OpenAI-compatible provider for tests: /models, /chat/completions (JSON and SSE),
 * /embeddings. Records the Authorization header it saw so tests can check which key ARC used.
 */
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockProvider {
  url: string;
  seenAuth: string[];
  /** Set to make the next requests fail with this status. */
  failWith: number | null;
  /** Number of SSE chunks to stream, and delay between chunks. */
  chunks: number;
  chunkDelayMs: number;
  /** Set when a client disconnected mid-stream. */
  streamAborted: boolean;
  /** Probability (0..1) that a request fails with 503 (to simulate a degraded provider). */
  failRate: number;
  /** Delay before any response (to test deadlines). */
  responseDelayMs: number;
  /** Last JSON body received. */
  lastBody: Record<string, unknown> | null;
  close(): Promise<void>;
}

export async function startMockProvider(): Promise<MockProvider> {
  const state: Omit<MockProvider, 'url' | 'close'> = {
    seenAuth: [],
    failWith: null,
    chunks: 3,
    chunkDelayMs: 5,
    streamAborted: false,
    responseDelayMs: 0,
    failRate: 0,
    lastBody: null,
  };

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      state.seenAuth.push(String(req.headers.authorization ?? ''));
      if (state.responseDelayMs) await new Promise((r) => setTimeout(r, state.responseDelayMs));
      const path = (req.url ?? '').replace(/^\/v1/, '');
      if (!state.failWith && state.failRate > 0 && Math.random() < state.failRate) {
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'mock random failure', type: 'mock' } }));
      }
      if (state.failWith) {
        res.writeHead(state.failWith, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'mock failure', type: 'mock' } }));
      }
      if (req.method === 'GET' && path === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({ object: 'list', data: [{ id: 'mock-chat' }, { id: 'mock-embed' }] }),
        );
      }
      const body = raw ? JSON.parse(raw) : {};
      state.lastBody = body;
      if (path === '/embeddings') {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            object: 'list',
            model: body.model,
            data: inputs.map((_: unknown, i: number) => ({
              object: 'embedding',
              index: i,
              embedding: [0.1, 0.2, 0.3],
            })),
            usage: { prompt_tokens: 3, total_tokens: 3 },
          }),
        );
      }
      if (path === '/chat/completions') {
        const id = 'chatcmpl-mock';
        const created = Math.floor(Date.now() / 1000);
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(
            JSON.stringify({
              id,
              object: 'chat.completion',
              created,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Hello from mock' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
            }),
          );
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        let finished = false;
        res.on('close', () => {
          if (!finished) state.streamAborted = true;
        });
        for (let i = 0; i < state.chunks; i++) {
          if (res.destroyed) return;
          const chunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: body.model,
            choices: [
              {
                index: 0,
                delta:
                  i === 0 ? { role: 'assistant', content: `tok${i}` } : { content: ` tok${i}` },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          await new Promise((r) => setTimeout(r, state.chunkDelayMs));
        }
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        finished = true;
        return res.end();
      }
      res.writeHead(404).end();
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const mock = state as MockProvider;
  mock.url = `http://127.0.0.1:${port}/v1`;
  mock.close = () =>
    new Promise((r) => {
      server.close(() => r());
      // Keep-alive connections from pooled clients would otherwise hold close() open.
      server.closeAllConnections();
    });
  return mock;
}
