import { Field, PageHead, Tabs } from '@arc/ui';
import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Try models through ARC with one of the organization's ARC keys, exactly as an app would call
 * /v1. The key lives in this component's state only: never stored, never sent anywhere but /v1.
 */

type Mode = 'chat' | 'speech' | 'transcription' | 'images';
const NEEDS: Record<Mode, string> = {
  chat: 'text',
  speech: 'speech',
  transcription: 'transcription',
  images: 'image_generation',
};
const MODE_TABS: { id: Mode; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'speech', label: 'Speech' },
  { id: 'transcription', label: 'Transcription' },
  { id: 'images', label: 'Images' },
];

interface V1Model {
  id: string;
  arc?: { capabilities: string[] };
}
interface Route {
  model: string;
  attempts: string;
  overheadMs: string;
  fallback: string | null;
}

async function v1(key: string, path: string, body: BodyInit, json = true): Promise<Response> {
  const res = await fetch(`/v1${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      ...(json ? { 'content-type': 'application/json' } : {}),
    },
    body,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(err?.error?.message ?? `ARC answered ${res.status}`);
  }
  return res;
}

const routeOf = (res: Response): Route => ({
  model: res.headers.get('x-arc-route-model') ?? '—',
  attempts: res.headers.get('x-arc-route-attempts') ?? '1',
  overheadMs: res.headers.get('x-arc-overhead-ms') ?? '—',
  fallback: res.headers.get('x-arc-fallback'),
});

export function PlaygroundPage() {
  const [key, setKey] = useState('');
  const [models, setModels] = useState<V1Model[] | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('chat');

  useEffect(() => {
    setModels(null);
    setKeyError(null);
    const k = key.trim();
    if (!/^ARC_/.test(k) || k.length < 20) return;
    const ctrl = new AbortController();
    fetch('/v1/models', { headers: { authorization: `Bearer ${k}` }, signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(r.status === 401 ? 'ARC doesn’t know this key.' : `Error ${r.status}`);
        setModels(((await r.json()) as { data: V1Model[] }).data);
      })
      .catch((e: Error) => e.name !== 'AbortError' && setKeyError(e.message));
    return () => ctrl.abort();
  }, [key]);

  const usable = (cap: string) => (models ?? []).filter((m) => m.arc?.capabilities.includes(cap));

  return (
    <div className="page medium">
      <PageHead
        title="Playground"
        sub="Try your models through ARC, the same way your apps call it."
      />
      <section className="panel panel-pad">
        <Field
          label="ARC key"
          error={keyError}
          hint={
            <>
              Paste a key from one of your <Link to="/apps">apps</Link>. It stays in this tab and is
              never saved. Requests count as that app’s traffic.
            </>
          }
        >
          {(id) => (
            <input
              id={id}
              className="input mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="ARC_…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          )}
        </Field>
      </section>

      {models && (
        <section className="section">
          <Tabs
            value={mode}
            onChange={setMode}
            tabs={MODE_TABS.map((t) => ({ ...t, count: usable(NEEDS[t.id]).length }))}
          />
          <div className="panel panel-pad mt-12" role="tabpanel">
            {usable(NEEDS[mode]).length === 0 ? (
              <p className="muted m-0 play-note">
                None of the models your keys can use do this yet. Add a{' '}
                <Link to="/keys">provider key</Link> whose provider offers it (for example Groq’s
                Whisper for transcription), then turn the model on in{' '}
                <Link to="/models">Models</Link>.
              </p>
            ) : (
              <Runner key={mode} mode={mode} arcKey={key.trim()} models={usable(NEEDS[mode])} />
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Runner({ mode, arcKey, models }: { mode: Mode; arcKey: string; models: V1Model[] }) {
  const [model, setModel] = useState('auto');
  const [text, setText] = useState('');
  const [voice, setVoice] = useState('alloy');
  const [size, setSize] = useState('1024x1024');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [output, setOutput] = useState<ReactNode>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  // Free the previous clip's memory when a new one replaces it or the tab closes.
  useEffect(() => () => void (audioUrl && URL.revokeObjectURL(audioUrl)), [audioUrl]);

  const ready = mode === 'transcription' ? !!file : text.trim().length > 0;

  async function run() {
    setBusy(true);
    setError(null);
    setOutput(null);
    setRoute(null);
    setAudioUrl(null);
    try {
      let res: Response;
      if (mode === 'chat') {
        res = await v1(
          arcKey,
          '/chat/completions',
          JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
        );
        const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        setOutput(<p className="play-text">{body.choices?.[0]?.message?.content ?? ''}</p>);
      } else if (mode === 'speech') {
        res = await v1(arcKey, '/audio/speech', JSON.stringify({ model, input: text, voice }));
        const url = URL.createObjectURL(await res.blob());
        setAudioUrl(url);
        setOutput(
          <audio controls src={url} className="play-audio" aria-label="Generated speech" />,
        );
      } else if (mode === 'transcription') {
        const fd = new FormData();
        fd.append('model', model);
        fd.append('file', file!);
        res = await v1(arcKey, '/audio/transcriptions', fd, false);
        const body = (await res.json()) as { text?: string };
        setOutput(<p className="play-text">{body.text ?? ''}</p>);
      } else {
        res = await v1(
          arcKey,
          '/images/generations',
          JSON.stringify({ model, prompt: text, size, response_format: 'b64_json' }),
        );
        const body = (await res.json()) as { data?: { b64_json?: string }[] };
        setOutput(
          <div className="play-images">
            {(body.data ?? [])
              .filter((d) => d.b64_json)
              .map((d, i) => (
                <img
                  key={i}
                  src={`data:image/png;base64,${d.b64_json}`}
                  alt={`Generated: ${text}`}
                />
              ))}
          </div>,
        );
      }
      setRoute(routeOf(res));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void run();
      }}
    >
      <Field label="Model" hint="Auto lets ARC choose, with fallback.">
        {(id) => (
          <select
            id={id}
            className="select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="auto">Auto</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        )}
      </Field>

      {mode === 'transcription' ? (
        <Field label="Audio file" hint="MP3, M4A, WAV, WebM… up to 20 MB.">
          {(id) => (
            <input
              id={id}
              className="input"
              type="file"
              accept="audio/*,video/webm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          )}
        </Field>
      ) : (
        <Field
          label={
            mode === 'chat' ? 'Message' : mode === 'speech' ? 'Text to say' : 'Describe the image'
          }
        >
          {(id) => (
            <textarea
              id={id}
              className="textarea"
              rows={4}
              maxLength={mode === 'speech' ? 4096 : 32000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
      )}

      {mode === 'speech' && (
        <Field label="Voice" hint="The provider’s voice name, e.g. alloy.">
          {(id) => (
            <input
              id={id}
              className="input"
              value={voice}
              maxLength={100}
              onChange={(e) => setVoice(e.target.value)}
            />
          )}
        </Field>
      )}
      {mode === 'images' && (
        <Field label="Size">
          {(id) => (
            <select
              id={id}
              className="select"
              value={size}
              onChange={(e) => setSize(e.target.value)}
            >
              <option value="1024x1024">Square (1024×1024)</option>
              <option value="1536x1024">Landscape (1536×1024)</option>
              <option value="1024x1536">Portrait (1024×1536)</option>
            </select>
          )}
        </Field>
      )}

      <button className="btn primary" disabled={!ready || busy}>
        {busy ? 'Running…' : 'Run'}
      </button>

      <div aria-live="polite">
        {error && <p className="error-text mt-12">{error}</p>}
        {output && <div className="play-result mt-16">{output}</div>}
        {route && (
          <p className="hint mt-8 mb-0">
            Answered by <span className="mono">{route.model}</span> · {route.attempts}{' '}
            {route.attempts === '1' ? 'attempt' : 'attempts'}
            {route.fallback ? ` (fell back after: ${route.fallback})` : ''} · ARC overhead{' '}
            {route.overheadMs} ms
          </p>
        )}
      </div>
    </form>
  );
}
