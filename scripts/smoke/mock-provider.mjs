#!/usr/bin/env node
/**
 * A stand-in OpenAI-compatible model provider for smoke tests. No dependencies.
 *
 * It answers the request shapes ARC's apps really send, so a smoke test exercises the whole path
 * (app → ARC → LiteLLM → provider) without a paid or rate-limited key:
 *   GET  /v1/models
 *   POST /v1/chat/completions  JSON or SSE; tool calls when tools are offered; JSON mode
 *   POST /v1/embeddings        honours `dimensions` (512 when absent)
 *
 * PORT (default 9000). Never use this outside tests.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 9000);

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * A tool call is returned only when the request requires one (tool_choice "required" or a named
 * function). With "auto" it answers in text, so apps that offer tools on every turn (Echo) get a
 * plain reply and the smoke test never triggers real side effects such as web searches.
 */
function toolCallFor(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const forced = body.tool_choice === 'required' || typeof body.tool_choice === 'object';
  if (!tools.length || !forced) return null;
  let fn = tools[0]?.function;
  if (body.tool_choice?.function?.name) {
    fn = tools.find((t) => t.function?.name === body.tool_choice.function.name)?.function ?? fn;
  }
  if (!fn?.name) return null;
  const args = {};
  for (const [k, v] of Object.entries(fn.parameters?.properties ?? {})) {
    if ((fn.parameters?.required ?? []).includes(k)) args[k] = v?.type === 'number' ? 1 : 'smoke';
  }
  return {
    id: `call_${Date.now().toString(36)}`,
    type: 'function',
    function: { name: fn.name, arguments: JSON.stringify(args) },
  };
}

function answerText(body) {
  if (
    body.response_format?.type === 'json_object' ||
    body.response_format?.type === 'json_schema'
  ) {
    return JSON.stringify({ ok: true, source: 'mock-provider' });
  }
  return 'Hello from the smoke-test provider.';
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const path = (req.url ?? '').replace(/^\/v1/, '').split('?')[0];
    if (req.method === 'GET' && (path === '/health' || path === '/'))
      return send(res, 200, { ok: true });
    if (!String(req.headers.authorization ?? '').startsWith('Bearer ')) {
      return send(res, 401, { error: { message: 'missing key', type: 'auth' } });
    }
    if (req.method === 'GET' && path === '/models') {
      return send(res, 200, { object: 'list', data: [{ id: 'mock-chat' }, { id: 'mock-embed' }] });
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { error: { message: 'bad json', type: 'invalid_request' } });
    }
    const created = Math.floor(Date.now() / 1000);
    if (path === '/embeddings') {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      // LiteLLM forwards `dimensions` only to providers it knows support it (e.g. Gemini, where it
      // becomes outputDimensionality) and drops it for generic OpenAI-compatible ones like this
      // stand-in, so default to 512: the size ARC's apps ask for.
      const dims = Number(body.dimensions) > 0 ? Number(body.dimensions) : 512;
      return send(res, 200, {
        object: 'list',
        model: body.model,
        data: inputs.map((_, i) => ({
          object: 'embedding',
          index: i,
          embedding: Array.from({ length: dims }, (_, j) =>
            Number((((i + 1) * (j + 1)) % 97) / 97),
          ),
        })),
        usage: { prompt_tokens: 3, total_tokens: 3 },
      });
    }
    if (path !== '/chat/completions') return send(res, 404, { error: { message: 'not found' } });

    const id = `chatcmpl-smoke-${created}`;
    const call = toolCallFor(body);
    const text = call ? null : answerText(body);
    const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
    if (!body.stream) {
      return send(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text, ...(call ? { tool_calls: [call] } : {}) },
            finish_reason: call ? 'tool_calls' : 'stop',
          },
        ],
        usage,
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    if (call) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, ...call }] });
      chunk({}, 'tool_calls');
    } else {
      const words = text.split(/(?<= )/);
      for (const [i, w] of words.entries()) {
        if (res.destroyed) return;
        chunk(i === 0 ? { role: 'assistant', content: w } : { content: w });
        await new Promise((r) => setTimeout(r, 5));
      }
      chunk({}, 'stop');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`mock provider on :${PORT}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
