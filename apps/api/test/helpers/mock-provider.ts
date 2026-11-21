/**
 * A tiny OpenAI-compatible provider for tests: /models, /chat/completions (JSON and SSE),
 * /embeddings, and optionally /audio/transcriptions, /audio/speech and /images/generations. Records the Authorization header it saw so tests can check which key ARC used.
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
  /** Fail selected requests: by key (Authorization header) or model, with a status and message. */
  failFor:
    ((r: { auth: string; model: unknown }) => { status: number; message: string } | null) | null;
  /** Delay before any response (to test deadlines). */
  responseDelayMs: number;
  /** Last JSON body (or multipart fields, plus `file` as {name, size}) received. */
  lastBody: Record<string, unknown> | null;
  close(): Promise<void>;
}

/** Bytes the mock's /audio/speech returns (an MP3 frame header and padding). */
export const MOCK_SPEECH = Buffer.from([0xff, 0xfb, 0x90, 0x64, ...Array<number>(60).fill(0)]);

/** A 1×1 PNG, as /images/generations returns it. */
export const MOCK_IMAGE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export async function startMockProvider(
  opts: { extraModels?: string[] } = {},
): Promise<MockProvider> {
  const modelIds = ['mock-chat', 'mock-embed', ...(opts.extraModels ?? [])];
  const state: Omit<MockProvider, 'url' | 'close'> = {
    seenAuth: [],
    failWith: null,
    chunks: 3,
    chunkDelayMs: 5,
    streamAborted: false,
    responseDelayMs: 0,
    failRate: 0,
    lastBody: null,
    failFor: null,
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
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
        return res.end(JSON.stringify({ object: 'list', data: modelIds.map((id) => ({ id })) }));
      }
      const raw = Buffer.concat(chunks);
      if (path === '/audio/transcriptions') {
        const form = await new Response(raw, {
          headers: { 'content-type': String(req.headers['content-type']) },
        }).formData();
        const fields: Record<string, unknown> = {};
        for (const [k, v] of form.entries()) {
          fields[k] = typeof v === 'string' ? v : { name: v.name, size: v.size };
        }
        state.lastBody = fields;
        const text = 'Hello from mock audio';
        if (fields.response_format === 'text') {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end(text);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ text }));
      }
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      const chosen = state.failFor?.({
        auth: String(req.headers.authorization ?? ''),
        model: body.model,
      });
      if (chosen) {
        res.writeHead(chosen.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: chosen.message, code: chosen.status } }));
      }
      state.lastBody = body;
      if (path === '/images/generations') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: Array.from({ length: Number(body.n ?? 1) }, () => ({ b64_json: MOCK_IMAGE_B64 })),
          }),
        );
      }
      if (path === '/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(MOCK_SPEECH);
      }
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
