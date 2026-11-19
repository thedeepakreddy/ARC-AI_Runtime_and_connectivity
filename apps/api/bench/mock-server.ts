/**
 * Standalone mock provider for load tests, in its own process so it does not share an event loop
 * with ARC or the load generator. Prints "<provider url> <control url>" on stdout.
 * POST <control url> with JSON { responseDelayMs, chunks, chunkDelayMs, failRate } to reconfigure.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockProvider } from '../test/helpers/mock-provider.js';

const mock = await startMockProvider();
const control = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const cfg = JSON.parse(body || '{}') as Partial<
      Record<'responseDelayMs' | 'chunks' | 'chunkDelayMs' | 'failRate', number>
    >;
    for (const k of ['responseDelayMs', 'chunks', 'chunkDelayMs', 'failRate'] as const) {
      if (typeof cfg[k] === 'number') mock[k] = cfg[k];
    }
    mock.seenAuth = [];
    res.writeHead(204).end();
  });
});
await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
process.stdout.write(`${mock.url} http://127.0.0.1:${(control.address() as AddressInfo).port}\n`);
process.on('SIGTERM', () => process.exit(0));
