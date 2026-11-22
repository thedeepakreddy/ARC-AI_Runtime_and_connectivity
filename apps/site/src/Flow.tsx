import { useEffect, useRef, useState } from 'react';

// How ARC works: one request, end to end, as the README's "How routing works" describes it.
// Scrolling moves through the seven stages (the section is pinned on wide screens; on phones it
// plays by itself). The inspector on the right shows each stage in the console's own style.
// It is an illustration of a single request: the model names, key hints and timings are
// examples, labelled as such; what each stage does is exactly what ARC does.

export const FLOW_EVENT = 'arc:flow-stage';

const STEPS = [
  {
    t: 'The request arrives',
    d: 'Your app calls one OpenAI-compatible endpoint with model "auto". ARC checks the app’s key and its rate limit.',
  },
  {
    t: 'What does it need?',
    d: 'Text, streaming, tools, JSON output, vision, audio: ARC reads the request and knows which models could serve it.',
  },
  {
    t: 'Every possible route',
    d: 'Each model this app may use, on each of its keys: owner keys, a customer’s own, or an end user’s, never mixed.',
  },
  {
    t: 'Gates',
    d: 'Disabled, out of region, resting after a rate limit, or unable to do what the request needs: those routes are out.',
  },
  {
    t: 'Rank',
    d: 'Health first, then free before paid, then general models before narrow ones, then the fastest by real traffic. No LLM, about a millisecond.',
  },
  {
    t: 'Execute, and fall back',
    d: 'The best route streams the answer. If it fails, the same model on another key, or a different model, inside the deadline.',
  },
  {
    t: 'Record',
    d: 'The route, the timings and the outcome, for your dashboards. Never the prompt, the response, files or secrets.',
  },
];

type Cand = { m: string; key: string; free: boolean; ms: number; gate?: string; score: number };
const CANDS: Cand[] = [
  { m: 'groq/llama-3.3-70b-versatile', key: '••••d87d', free: true, ms: 310, score: 0.96 },
  { m: 'groq/llama-3.3-70b-versatile', key: '••••41aa', free: true, ms: 330, score: 0.93 },
  { m: 'gemini/gemini-2.5-flash', key: '••••9c02', free: true, ms: 520, score: 0.84 },
  {
    m: 'cerebras/llama-3.3-70b',
    key: '••••77e1',
    free: true,
    ms: 260,
    gate: 'Resting 18 s',
    score: 0,
  },
  { m: 'openrouter/qwen/qwen3-coder:free', key: '••••0b3f', free: true, ms: 880, score: 0.61 },
  {
    m: 'mistral/mistral-small-latest',
    key: '••••5d10',
    free: true,
    ms: 480,
    gate: 'Region not allowed',
    score: 0,
  },
  {
    m: 'cloudflare/llama-3.1-8b-instruct',
    key: '••••a2c4',
    free: true,
    ms: 400,
    gate: 'No tool support',
    score: 0,
  },
  {
    m: 'openrouter/openai/gpt-4o',
    key: '••••0b3f',
    free: false,
    ms: 640,
    gate: 'Paid · off',
    score: 0,
  },
];
const NEEDS = [
  ['Text', true],
  ['Streaming', true],
  ['Tools', true],
  ['JSON output', true],
  ['Vision', false],
  ['Audio', false],
  ['Speech', false],
] as const;
const ANSWER =
  'Customers on monthly plans leave three times as often; offer an annual switch at renewal.';

const still = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function Flow({ onStage }: { onStage?: (stage: number) => void }) {
  const [stage, setStage] = useState(still() ? 6 : 0);
  const [sub, setSub] = useState(still() ? 99 : 0);
  const root = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);

  // Wide screens: the page's scroll choreography pins the section and tells us the stage.
  useEffect(() => {
    const on = (e: Event) => {
      pinned.current = true;
      setStage((e as CustomEvent<number>).detail);
    };
    window.addEventListener(FLOW_EVENT, on);
    return () => window.removeEventListener(FLOW_EVENT, on);
  }, []);
  // Phones (not pinned): play by itself while on screen.
  useEffect(() => {
    if (still()) return;
    const el = root.current;
    if (!el) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting && !pinned.current)
          timer ??= setInterval(() => {
            if (!pinned.current) setStage((s) => (s + 1) % STEPS.length);
          }, 3600);
        else if (timer) {
          clearInterval(timer);
          timer = null;
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearInterval(timer);
    };
  }, []);
  // Each stage plays its own small animation (sub counts its beats).
  useEffect(() => {
    if (still()) return;
    setSub(0);
    let k = 0;
    const beats = [0, 7, 0, 8, 4, 0, 5][stage] ?? 0;
    const pace = stage === 5 ? 90 : 260;
    const id = setInterval(() => {
      k++;
      setSub(k);
      if (k >= (stage === 5 ? 60 : beats + 1)) clearInterval(id);
    }, pace);
    onStage?.(stage);
    return () => clearInterval(id);
  }, [stage, onStage]);

  const progress = (stage + 1) / STEPS.length;
  return (
    <div className="flow" ref={root}>
      <div>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.t} className={i === stage ? 'on' : i < stage ? 'done' : ''}>
              <span className="n">{i < stage ? '✓' : i + 1}</span>
              <div>
                <h3>{s.t}</h3>
                {i === stage && <p>{s.d}</p>}
              </div>
            </li>
          ))}
        </ol>
        <div className="flow-progress" aria-hidden="true">
          <i style={{ transform: `scaleX(${progress})` }} />
        </div>
      </div>
      <div className="panel inspector" aria-live="polite">
        <div className="bar">
          <span className="dot live" />
          Request inspector
          <span className="right mono">req_7f3c2a</span>
        </div>
        <Stage stage={stage} sub={sub} />
        <div className="row" style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
          <span className="illus">
            Illustration of one request: model names, key hints and timings are examples.
          </span>
        </div>
      </div>
    </div>
  );
}

function Stage({ stage, sub }: { stage: number; sub: number }) {
  if (stage === 0) {
    return (
      <div className="stage">
        <pre
          className="mono"
          style={{ margin: 0, color: 'var(--text-2)', lineHeight: 1.8, whiteSpace: 'pre-wrap' }}
        >
          <span style={{ color: 'var(--accent-text)' }}>POST</span> /v1/chat/completions{'\n'}
          Authorization: Bearer ARC_DEE_…_PAK_…{'\n'}
          {'{'} "model": <span style={{ color: 'var(--text)' }}>"auto"</span>, "stream": true,
          "tools": [ … ],{'\n'}
          {'  '}"response_format": {'{'} "type": "json_schema" {'}'}, "messages": [ … ] {'}'}
        </pre>
        <div className="row" style={{ padding: '6px 0' }}>
          <span className="badge ok">
            <span className="dot" />
            Key verified
          </span>
          <span className="muted mono">hash match · scope inference</span>
        </div>
        <div className="row" style={{ padding: '6px 0' }}>
          <span className="badge blue">Rate limit</span>
          <div className="meter" aria-label="Requests this minute">
            {Array.from({ length: 12 }, (_, i) => (
              <i key={i} className={i < 5 ? 'on' : ''} />
            ))}
          </div>
          <span className="muted mono">5 / 60 per minute, shared across instances</span>
        </div>
      </div>
    );
  }
  if (stage === 1) {
    return (
      <div className="stage">
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Read from the request itself:
        </p>
        <div className="chips">
          {NEEDS.map(([n, needed], i) => (
            <span key={n} className={`chip${needed && sub > i ? ' on' : ''}`}>
              {needed && sub > i ? '● ' : ''}
              {n}
            </span>
          ))}
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Only models that can do all of the lit ones are considered.
        </p>
      </div>
    );
  }
  if (stage === 2 || stage === 3) {
    return (
      <div className="stage">
        {CANDS.map((c, i) => {
          const out =
            stage === 3 && !!c.gate && sub > Math.max(0, CANDS.filter((x) => x.gate).indexOf(c));
          return (
            <div
              key={c.m + c.key}
              className={`cand${out ? ' out' : ''}`}
              style={{
                opacity: stage === 2 ? undefined : undefined,
                transitionDelay: stage === 2 ? `${i * 70}ms` : undefined,
              }}
            >
              <span className="m">{c.m}</span>
              <span className="key">{c.key}</span>
              {out ? (
                <span className="badge bad">{c.gate}</span>
              ) : (
                <span className={`badge ${c.free ? 'ok' : ''}`}>{c.free ? 'Free' : 'Paid'}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  }
  if (stage === 4) {
    const live = CANDS.filter((c) => !c.gate).sort((a, b) => b.score - a.score);
    return (
      <div className="stage">
        <div className="row" style={{ padding: 0, gap: 8 }}>
          {['Health', 'Free before paid', 'General before narrow', 'Fastest by real traffic'].map(
            (k, i) => (
              <span key={k} className={`badge${sub > i ? ' blue' : ''}`}>
                {i + 1}. {k}
              </span>
            ),
          )}
        </div>
        {live.map((c, i) => (
          <div key={c.m + c.key} className={`cand${i === 0 && sub > 3 ? ' best' : ''}`}>
            <span className="m">
              {c.m} <span className="key">{c.key}</span>
            </span>
            <span className="score">
              <i style={{ width: `${sub > 3 ? c.score * 100 : sub * 22}%` }} />
            </span>
            <span className="key">{c.ms} ms</span>
          </div>
        ))}
        <p className="muted mono" style={{ margin: 0 }}>
          Decided in memory · no LLM call · ~1 ms
        </p>
      </div>
    );
  }
  if (stage === 5) {
    const t = Math.min(sub, 60);
    const firstDone = t > 10,
      secondStart = t > 14;
    const words = ANSWER.split(' ');
    const shown = secondStart
      ? words.slice(0, Math.max(0, Math.floor((t - 18) / 1.4))).join(' ')
      : '';
    return (
      <div className="stage">
        <div className="attempt">
          <span className="badge">1</span>
          <span className="mono">groq/llama-3.3-70b-versatile ••••d87d</span>
          {firstDone ? (
            <span className="badge warn">
              <span className="dot warn" />
              429 · key rests 20 s
            </span>
          ) : (
            <span className="badge blue">Trying…</span>
          )}
        </div>
        {secondStart && (
          <div className="attempt">
            <span className="badge">2</span>
            <span className="mono">same model, ••••41aa</span>
            <span className={`badge ${t > 18 ? 'ok' : 'blue'}`}>
              {t > 18 ? (
                <>
                  <span className="dot" />
                  200 · streaming
                </>
              ) : (
                'Trying…'
              )}
            </span>
          </div>
        )}
        <div>
          <div className="row" style={{ padding: '0 0 6px' }}>
            <span className="muted mono">x-arc-deadline-ms 30000</span>
            <span className="muted mono" style={{ marginLeft: 'auto' }}>
              never starts an attempt it can’t finish
            </span>
          </div>
          <div className="deadline">
            <i style={{ width: `${Math.min(100, t * 1.1)}%` }} />
            <b style={{ left: '92%' }} />
          </div>
        </div>
        <div className="stream">
          {shown}
          {t < 60 && secondStart && <span className="caret" />}
        </div>
      </div>
    );
  }
  return (
    <div className="stage">
      <dl className="kv">
        <dt>x-arc-route-provider</dt>
        <dd>groq</dd>
        <dt>x-arc-route-model</dt>
        <dd>groq/llama-3.3-70b-versatile</dd>
        <dt>x-arc-route-attempts</dt>
        <dd>2</dd>
        <dt>x-arc-overhead-ms</dt>
        <dd>4</dd>
      </dl>
      <div className="row" style={{ padding: '4px 0' }}>
        <span className="badge ok">
          <span className="dot" />
          Recorded
        </span>
        <span className="muted">route · timings · outcome · the key that rested</span>
      </div>
      <div className="row" style={{ padding: '4px 0' }}>
        <span className="badge">Never logged</span>
        <span className="muted">prompt · response · files · secrets</span>
      </div>
      <div className="row" style={{ padding: '4px 0' }}>
        <span className="badge blue">Learning</span>
        <span className="muted">
          a background worker updates latency and health for the next request
        </span>
      </div>
    </div>
  );
}
