import { Wordmark } from '@arc/ui';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Flow } from './Flow';
import { DebugPanel } from './DebugPanel';
import { noteError } from './debug';
import { markOpeningSeen } from './opening';
import type { Sky } from './scene';

// The ARC website: the opening (a load page drawn in the sky), then one long page that
// explains what ARC is, how a request moves through it, and where it runs. Try now leads to the
// customer dashboard's sign-in (/dashboard), which goes on to the dashboard itself.
// Everything stated here comes from the README and the docs.

const REPO = 'https://github.com/thedeepakreddy/ARC-AI_Runtime_and_connectivity';
const DOC = (p: string) => `${REPO}/blob/main/${p}`;
const still = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const PROVIDERS: Array<[string, string[]]> = [
  [
    'Global',
    [
      'Google Gemini',
      'Groq',
      'OpenRouter',
      'Mistral',
      'Cerebras',
      'SambaNova',
      'Cloudflare Workers AI',
      'GitHub Models',
      'Hugging Face',
      'NVIDIA NIM',
      'Cohere',
      'Together AI',
      'Fireworks',
      'Nebius',
      'DeepInfra',
    ],
  ],
  [
    'China',
    [
      'Alibaba (Qwen)',
      'ModelScope',
      'DeepSeek',
      'Moonshot (Kimi)',
      'Zhipu (GLM)',
      'MiniMax',
      'Baidu Qianfan',
      'Tencent Hunyuan',
      'ByteDance Ark',
      'StepFun',
      'SiliconFlow',
    ],
  ],
  ['Local', ['Ollama', 'vLLM', 'LM Studio', 'llama.cpp']],
  ['Speech & embeddings', ['Deepgram', 'AssemblyAI', 'ElevenLabs', 'Jina', 'Voyage']],
];

const CODE: Record<string, string> = {
  curl: `curl https://arc-ai.run.place/v1/chat/completions \\
  -H "Authorization: Bearer $ARC_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Hello"}]}'`,
  Node: `import OpenAI from 'openai';

const arc = new OpenAI({
  baseURL: 'https://arc-ai.run.place/v1',
  apiKey: process.env.ARC_API_KEY, // ARC_DEE_…_PAK_…
});

const stream = await arc.chat.completions.create({
  model: 'auto', // ARC chooses the provider, model and key
  stream: true,
  messages: [{ role: 'user', content: 'Summarise this in one line: …' }],
});`,
  Python: `from openai import OpenAI
import os

arc = OpenAI(
    base_url="https://arc-ai.run.place/v1",
    api_key=os.environ["ARC_API_KEY"],  # ARC_DEE_…_PAK_…
)

reply = arc.chat.completions.create(
    model="auto",  # or arc/fast, arc/balanced, arc/deep
    messages=[{"role": "user", "content": "Hello"}],
)`,
};

/** Colours keys, strings and comments, the way an editor would. */
function paint(code: string) {
  const out: Array<string | React.ReactElement> = [];
  const re =
    /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(import|from|const|await|true|for|curl|os)\b/gm;
  let last = 0,
    m: RegExpExecArray | null,
    k = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    out.push(
      <span key={k++} className={m[1] ? 'tok-c' : m[2] ? 'tok-s' : 'tok-k'}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  out.push(code.slice(last));
  return out;
}

/** Letters wrapped for the scroll motion (words kept whole). */
function Split({ text }: { text: string }) {
  return (
    <span aria-label={text}>
      {text.split(' ').map((w, i, all) => (
        <span key={i} className="word" aria-hidden="true">
          {[...w].map((c, j) => (
            <span key={j} className="char">
              {c}
            </span>
          ))}
          {i < all.length - 1 && <span className="char">&nbsp;</span>}
        </span>
      ))}
    </span>
  );
}

/** A heading whose words rise one by one from behind a mask. */
function Words({ text }: { text: string }) {
  return (
    <span aria-label={text}>
      {text.split(' ').map((w, i) => (
        // A real space between words (not a margin), so a wrapped line doesn't start indented.
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className="wmask" aria-hidden="true">
            <span className="w">{w}</span>
          </span>
        </Fragment>
      ))}
    </span>
  );
}

const Arrow = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M3 8h10M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** The sky, explained: what the scene models, with the real numbers behind it. */
const PHYSICS: Array<{ title: string; eq: string; body: string }> = [
  {
    title: 'Sunlight from 150 million km',
    eq: '1 AU ≈ 149.6 million km · light takes 8 min 20 s',
    body: 'The Sun is so far away that its rays arrive parallel, so one direction lights the whole planet. It sits just behind Earth here, which is why you see a thin sunlit crescent and the night side.',
  },
  {
    title: 'Why the limb is blue',
    eq: 'Rayleigh scattering ∝ 1/λ⁴ · blue scatters ≈ 6× red',
    body: 'Air molecules scatter short wavelengths far more than long ones, so sunlit air glows blue against black space. The haze thickens towards the edge, where your line of sight crosses more air.',
  },
  {
    title: 'The orange twilight band',
    eq: 'air mass at the horizon ≈ 38× overhead',
    body: 'At the terminator, sunlight skims through almost 40 times more air before it reaches the ground. The blue is scattered away on the way in, and what arrives is orange and red: sunset, seen from orbit.',
  },
  {
    title: 'The arc of light',
    eq: 'Mie scattering peaks forward · g → 1',
    body: 'Dust and droplets scatter light mostly onwards, in the direction it was already going. Looking through the limb towards the Sun, the air blazes white-gold: the arc astronauts photograph at every orbital sunrise.',
  },
  {
    title: 'Ocean glint and city lights',
    eq: 'mirror reflection where n̂ bisects sun and eye',
    body: 'Calm water reflects the Sun like a mirror, so it shines only where the surface tilts exactly between the Sun and you; land and cloud are too rough. On the night side, city lights glow through gaps in the clouds.',
  },
  {
    title: 'Orbits and Earth’s shadow',
    eq: 'v = √(GM/r) · 420 km → 7.66 km/s, 92.8 min',
    body: 'A station at 420 km circles Earth every 93 minutes, broadband satellites at 550 km every 95, launched in a line like a string of pearls. Entering Earth’s shadow, they go dark: about 16 sunsets a day.',
  },
  {
    title: 'Real stars',
    eq: 'brightness ∝ 10^(−0.4 m) · colour from B−V',
    body: '25,723 stars from ESA’s Hipparcos catalogue, at their true positions. Each magnitude step is 2.512 times dimmer; colour comes from the star’s temperature, from blue-white giants to orange dwarfs.',
  },
  {
    title: 'The Milky Way',
    eq: 'galactic centre ≈ 26,000 light-years away',
    body: 'Our own galaxy’s disc, seen edge-on from inside it, drawn from the Milky Way Outline Catalog. The bright core rises in Sagittarius; the dark rifts are dust clouds blocking the starlight behind them.',
  },
  {
    title: 'Depth, and what is enlarged',
    eq: 'objects in orbit ≈ 9,000× larger, ≈ 20× faster',
    body: 'Stars are at infinity, so they never shift as the camera flies; the nearby motes do (parallax). The station and satellites would be invisible specks at true size. The requests fall under inverse-square gravity while steering for a station: a picture of routing, not network physics.',
  },
];

export function Site() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sky = useRef<Sky | null>(null);
  // main.tsx decides (before the first render) whether the opening plays.
  const [intro, setIntro] = useState(() => document.documentElement.classList.contains('intro-on'));
  const [tab, setTab] = useState<keyof typeof CODE>('curl');

  // The sky and the page's motion load on their own (three.js and GSAP).
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    let cancelled = false,
      cleanup = () => {};

    Promise.all([import('./scene'), import('./motion')])
      .then(([{ createSky, skyTier }, { initMotion }]) => {
        if (cancelled) return;
        const calm = still();
        const opening = document.documentElement.classList.contains('intro-on');
        let s: Sky | null = null;
        try {
          s = createSky(cv, {
            tier: skyTier(),
            intro: !calm && opening,
            still: calm,
          });
        } catch (e) {
          // The opening stays up with its Get started button even without the sky.
          noteError('createSky', e);
        }
        sky.current = s;
        const stop = calm ? () => {} : initMotion(s);
        const onResize = () => s?.resize();
        const nd = (e: PointerEvent) =>
          [
            (e.clientX / window.innerWidth) * 2 - 1,
            -(e.clientY / window.innerHeight) * 2 + 1,
          ] as const;
        const onMove = (e: PointerEvent) => {
          const [x, y] = nd(e);
          s?.setPointer(x, y);
        };
        const onLeave = () => s?.setPointer(null, null);
        const onDown = (e: PointerEvent) => {
          if ((e.target as HTMLElement | null)?.closest('a,button,pre,input,table')) return;
          const [x, y] = nd(e);
          s?.flare(x, y);
        };
        window.addEventListener('resize', onResize);
        window.addEventListener('pointermove', onMove);
        document.addEventListener('pointerleave', onLeave);
        window.addEventListener('pointerdown', onDown);
        cleanup = () => {
          stop();
          window.removeEventListener('resize', onResize);
          window.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerleave', onLeave);
          window.removeEventListener('pointerdown', onDown);
          s?.dispose();
        };
      })
      .catch((e) => noteError('load', e));
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  // The opening stays until the visitor clicks Get started (no timeout; scrolling and keys don't
  // end it). The click finishes the sky's opening at once if it's still playing, then shows the page.
  useEffect(() => {
    document.documentElement.classList.toggle('intro-on', intro);
    document.body.style.overflow = intro ? 'hidden' : '';
    if (!intro) markOpeningSeen();
  }, [intro]);
  const getStarted = useCallback(() => {
    sky.current?.skipIntro();
    setIntro(false);
  }, []);

  // Try now: a warp out of the page while the sign-in loads. The browser keeps showing the warp
  // until the next page is ready, so the load starts early rather than after the animation.
  const leaving = useRef(false);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const restore = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    leaving.current = false;
    document.documentElement.classList.remove('warping');
    sky.current?.unwarp();
  }, []);
  const tryNow = useCallback(
    (e: React.MouseEvent) => {
      if (still() || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      if (leaving.current) return;
      leaving.current = true;
      sky.current?.warp();
      document.documentElement.classList.add('warping');
      timers.current = [
        setTimeout(() => window.location.assign('/dashboard/'), 380),
        // Still here long after (offline, or the load was stopped)? Bring the page back.
        setTimeout(restore, 8000),
      ];
    },
    [restore],
  );
  // Coming back (Back button or swipe) can restore this page exactly as it was left: mid-warp,
  // zoomed in, faded out. Undo that.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted || leaving.current) restore();
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [restore]);
  const flowStage = useCallback((n: number) => sky.current?.flowStage(n), []);
  const go = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: still() ? 'auto' : 'smooth' });

  const tryButton = (lg = false) => (
    <a className={`btn primary${lg ? ' lg' : ''}`} href="/dashboard/" onClick={tryNow}>
      Try now <Arrow />
    </a>
  );

  return (
    <>
      <canvas ref={canvas} className="sky" aria-hidden="true" />
      <DebugPanel />
      <div className="veil" aria-hidden="true" />

      {intro && (
        <div className="intro show" data-intro>
          <div className="mark">
            <Wordmark height={64} />
            <p>AI Runtime &amp; Connectivity</p>
          </div>
          <button type="button" className="btn primary lg start" onClick={getStarted}>
            Get started <Arrow />
          </button>
        </div>
      )}

      <div className="page">
        <div className="orbit-progress" aria-hidden="true">
          <i data-progress />
          <b data-progress-dot />
        </div>
        <header className="top">
          <div className="wrap">
            <a className="brand" href="/" aria-label="ARC home">
              <Wordmark height={18} />
              <small>AI Runtime &amp; Connectivity</small>
            </a>
            <nav className="nav" aria-label="Sections">
              <button type="button" onClick={() => go('how')}>
                How it works
              </button>
              <button type="button" onClick={() => go('providers')}>
                Providers
              </button>
              <button type="button" onClick={() => go('platform')}>
                Platform
              </button>
              <button type="button" onClick={() => go('security')}>
                Security
              </button>
              <a href={DOC('docs/inference-api.md')} target="_blank" rel="noreferrer">
                API docs
              </a>
            </nav>
            <div className="end">
              <a className="btn ghost" href="/dashboard/">
                Sign in
              </a>
              {tryButton()}
            </div>
          </div>
        </header>

        <main>
          <section data-shot="0" className="wrap hero">
            <span className="eyebrow" data-rise>
              AI Runtime &amp; Connectivity
            </span>
            <h1 className="display" data-split style={{ marginTop: 22 }}>
              <Split text="One API in front of every AI provider." />
            </h1>
            <p className="lead" data-rise>
              ARC picks the model, the key and the fallback, for every request. Your apps send one
              OpenAI-compatible call with{' '}
              <span className="mono" style={{ color: 'var(--text)' }}>
                model: "auto"
              </span>
              ; they never hold a provider key or write a retry loop.
            </p>
            <div className="ctas" data-rise>
              {tryButton(true)}
              <button type="button" className="btn lg" onClick={() => go('how')}>
                See how it works
              </button>
            </div>
            <div className="route-card" data-rise>
              <div className="head">
                <span className="dot live" />
                One request, routed{' '}
                <span className="muted mono" style={{ marginLeft: 'auto' }}>
                  example response headers
                </span>
              </div>
              <pre>
                <span className="k">x-arc-route-provider:</span> <span className="v">groq</span>
                {'\n'}
                <span className="k">x-arc-route-model:</span>{' '}
                <span className="v">groq/llama-3.3-70b-versatile</span>
                {'\n'}
                <span className="k">x-arc-route-attempts:</span> <span className="v">1</span>
                {'\n'}
                <span className="k">x-arc-overhead-ms:</span> <span className="v">4</span>
              </pre>
            </div>
          </section>

          <section data-shot="1" className="wrap" aria-label="ARC in numbers">
            <div className="facts">
              <div className="fact" data-fact>
                <b>
                  <span data-count="36">36</span>
                </b>
                <span>providers in the catalogue</span>
              </div>
              <div className="fact" data-fact>
                <b>~1 ms</b>
                <span>to decide a route, with no LLM call</span>
              </div>
              <div className="fact" data-fact>
                <b>
                  ≤ <span data-count="30">30</span> ms
                </b>
                <span>ARC overhead at p95, gated in CI</span>
              </div>
              <div className="fact" data-fact>
                <b>
                  <span data-count="24">24</span> ms
                </b>
                <span>average ARC overhead per request</span>
              </div>
              <div className="fact" data-fact>
                <b>
                  $<span data-count="0">0</span>
                </b>
                <span>to run, on Oracle’s Always Free Arm VM</span>
              </div>
              <div className="fact" data-fact>
                <b>
                  <span data-count="0">0</span>
                </b>
                <span>prompts or responses ever logged</span>
              </div>
            </div>
          </section>

          <section data-shot="2" id="how" className="block" data-flow>
            <div className="wrap">
              <div className="block-head">
                <div>
                  <span className="eyebrow">How ARC works</span>
                  <h2 className="h2" data-words>
                    <Words text="Every request finds a way through." />
                  </h2>
                </div>
                <p className="lead" data-reveal>
                  Seven steps, a few milliseconds of ARC’s own time. Scroll to follow one request:
                  what it needs, which routes it may take, which are ruled out, how the rest are
                  ranked, and what happens when the first choice fails.
                </p>
              </div>
              <Flow onStage={flowStage} />
            </div>
          </section>

          <section data-shot="3" className="block">
            <div className="wrap">
              <div className="block-head">
                <div>
                  <span className="eyebrow">Fallback</span>
                  <h2 className="h2" data-words>
                    <Words text="One rate-limited key never takes your app down." />
                  </h2>
                </div>
                <p className="lead" data-reveal>
                  Pool several keys per provider; each is routed, rate-limited and health-checked on
                  its own. A key that hits a limit rests for as long as the provider asks, and the
                  request moves on: the same model on another key first, then a different model. In
                  the sky behind this page, amber stations are resting; watch their requests change
                  course.
                </p>
              </div>
              <div className="cards">
                <div className="card" data-reveal>
                  <h3>Cooldowns</h3>
                  <p>
                    Rate-limited keys rest for as long as the provider asks; failing keys back off.
                    A key that is out of credits rests too.
                  </p>
                </div>
                <div className="card" data-reveal>
                  <h3>Deadlines</h3>
                  <p>
                    Every request carries one (<span className="mono">x-arc-deadline-ms</span>). ARC
                    never starts an attempt it can’t finish, and never replays work already done.
                  </p>
                </div>
                <div className="card" data-reveal>
                  <h3>Route explanation</h3>
                  <p>
                    Send <span className="mono">x-arc-explain: true</span> and ARC returns why each
                    candidate was chosen or rejected.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section data-shot="4" className="block">
            <div className="wrap code">
              <div>
                <span className="eyebrow">For developers</span>
                <h2 className="h2" data-words style={{ marginTop: 18 }}>
                  <Words text="Change the base URL. Keep your code." />
                </h2>
                <p className="lead" data-reveal style={{ marginTop: 20 }}>
                  Any OpenAI SDK works. Chat with streaming, tools and JSON schema output,
                  embeddings, speech to text, text to speech, images, and the model list for your
                  key.
                </p>
                <div className="chips" data-reveal style={{ marginTop: 24 }}>
                  {[
                    '/v1/chat/completions',
                    '/v1/embeddings',
                    '/v1/audio/transcriptions',
                    '/v1/audio/speech',
                    '/v1/images/generations',
                    '/v1/models',
                  ].map((p) => (
                    <span key={p} className="chip on mono">
                      {p}
                    </span>
                  ))}
                </div>
                <div className="chips" data-reveal style={{ marginTop: 14 }}>
                  {['auto', 'arc/fast', 'arc/balanced', 'arc/deep', 'provider/model'].map((p) => (
                    <span key={p} className="chip mono">
                      {p}
                    </span>
                  ))}
                </div>
              </div>
              <div className="panel" data-reveal>
                <div className="tabs" role="tablist">
                  {(Object.keys(CODE) as Array<keyof typeof CODE>).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="tab"
                      aria-selected={tab === k}
                      onClick={() => setTab(k)}
                    >
                      {k}
                    </button>
                  ))}
                </div>
                <pre>
                  <code>{paint(CODE[tab]!)}</code>
                </pre>
              </div>
            </div>
          </section>

          <section data-shot="5" id="providers" className="block">
            <div className="wrap">
              <div className="block-head">
                <div>
                  <span className="eyebrow">Providers and models</span>
                  <h2 className="h2" data-words>
                    <Words text="36 providers. Free tiers first, honestly." />
                  </h2>
                </div>
                <p className="lead" data-reveal>
                  From global clouds to Chinese labs to local runtimes, plus OpenAI, Anthropic, Meta
                  and hundreds more through OpenRouter. When a key is checked, ARC reads the
                  provider’s own listing and classifies every model: a model counts as free only
                  with evidence.
                </p>
              </div>
            </div>
            <div className="marquee" data-marquee="1">
              <div className="track">
                {[...PROVIDERS.flatMap(([, l]) => l), ...PROVIDERS.flatMap(([, l]) => l)].map(
                  (p, i) => (
                    <span key={i} className="prov">
                      <i />
                      {p}
                    </span>
                  ),
                )}
              </div>
            </div>
            <div className="marquee" data-marquee="-1" style={{ marginTop: 10 }}>
              <div className="track">
                {[
                  ...PROVIDERS.flatMap(([, l]) => l).reverse(),
                  ...PROVIDERS.flatMap(([, l]) => l).reverse(),
                ].map((p, i) => (
                  <span key={i} className="prov">
                    <i />
                    {p}
                  </span>
                ))}
              </div>
            </div>
            <div className="wrap">
              <div className="groups">
                {PROVIDERS.map(([g, l]) => (
                  <div key={g} className="panel" data-reveal>
                    <h3>{g}</h3>
                    <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                      {l.length} providers
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section data-shot="6" className="block">
            <div className="wrap">
              <div className="block-head">
                <div>
                  <span className="eyebrow">What makes ARC different</span>
                  <h2 className="h2" data-words>
                    <Words text="An operator-grade runtime you own." />
                  </h2>
                </div>
                <p className="lead" data-reveal>
                  It routes like a hosted service, pools free tiers like nothing else, and stays in
                  your infrastructure.
                </p>
              </div>
              <table className="compare" data-reveal>
                <thead>
                  <tr>
                    <th scope="col" />
                    <th scope="col">ARC</th>
                    <th scope="col" className="hide-sm">
                      Typical hosted router
                    </th>
                    <th scope="col" className="hide-sm">
                      Typical gateway proxy
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [
                      'Who holds the provider keys',
                      <>
                        <b>You.</b> Encrypted in your own vault, on your own server
                      </>,
                      'The service, or credits you buy',
                      'You, in config files',
                    ],
                    [
                      'Several keys per provider',
                      <>
                        <b>Yes.</b> Each routed, rate-limited and health-checked on its own
                      </>,
                      'Usually one account',
                      'Possible, by hand',
                    ],
                    [
                      'Free tiers first',
                      <>
                        <b>Yes.</b> Free only with evidence: the provider’s price, or a link you
                        record
                      </>,
                      'Priced per token',
                      'Not a concept',
                    ],
                    [
                      'Fallback',
                      <>
                        <b>Across keys and models</b>, inside the deadline, never replaying work
                      </>,
                      'Varies',
                      'Configured per route',
                    ],
                    [
                      'Routing decision',
                      <>
                        <b>In memory, no LLM</b>, about a millisecond
                      </>,
                      'Varies',
                      'Static rules',
                    ],
                    [
                      'Multi-tenant with BYOK',
                      <>
                        <b>Yes.</b> Customers’ traffic never touches yours
                      </>,
                      'Shared credits',
                      'Not built in',
                    ],
                    [
                      'Data residency',
                      <>
                        <b>Per tenant and per app</b>: allowed regions
                      </>,
                      'Limited',
                      'By hand',
                    ],
                    [
                      'Logging',
                      <>
                        <b>Metadata only.</b> Never prompts, responses or secrets
                      </>,
                      'Varies',
                      'Often full payloads',
                    ],
                  ].map(([k, a, b, c], i) => (
                    <tr key={i} data-row>
                      <td>{k}</td>
                      <td className="arc">{a}</td>
                      <td className="other hide-sm">{b}</td>
                      <td className="other hide-sm">{c}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section data-shot="6.5" id="platform" className="block">
            <div className="wrap">
              <div className="block-head">
                <div>
                  <span className="eyebrow">The platform</span>
                  <h2 className="h2" data-words>
                    <Words text="A console for the owner. A dashboard for everyone else." />
                  </h2>
                </div>
                <p className="lead" data-reveal>
                  Run ARC for yourself, or for customers who bring their own keys. Each sees only
                  their own keys, apps, models and usage.
                </p>
              </div>
              <div className="cards">
                <div className="card" data-reveal>
                  <h3>Owner console</h3>
                  <span className="mono">/console</span>
                  <ul>
                    <li>Provider keys and their health</li>
                    <li>The model catalogue and classification</li>
                    <li>Apps, ARC keys and routing policies</li>
                    <li>Traffic, latency, fallbacks and errors</li>
                    <li>Customers and the audit log</li>
                  </ul>
                </div>
                <div className="card" data-reveal>
                  <h3>Customer dashboard</h3>
                  <span className="mono">/dashboard</span>
                  <ul>
                    <li>Sign up with email or Google</li>
                    <li>Bring your own provider keys</li>
                    <li>Choose models, create apps, issue keys</li>
                    <li>Usage, team and roles, per-app regions</li>
                    <li>A Playground: chat, speech, transcription, images</li>
                  </ul>
                </div>
                <div className="card" data-reveal>
                  <h3>Your users’ own keys</h3>
                  <span className="mono">x-arc-user</span>
                  <ul>
                    <li>
                      Register a user’s key once:{' '}
                      <span className="mono">PUT /v1/user-keys/:provider</span>
                    </li>
                    <li>Send the same header on their requests</li>
                    <li>They run only on that user’s key, with full routing and fallback</li>
                  </ul>
                </div>
              </div>
            </div>
          </section>

          <section data-shot="7" id="security" className="block">
            <div className="wrap">
              <div className="block-head">
                <div>
                  <span className="eyebrow">Security</span>
                  <h2 className="h2" data-words>
                    <Words text="Your keys stay yours. Your prompts stay unread." />
                  </h2>
                </div>
                <p className="lead" data-reveal>
                  Provider keys are encrypted at rest and never returned by any API. Logs carry
                  metadata only: prompts, responses, files and secrets never reach them.
                </p>
              </div>
              <div className="cards">
                <div className="card" data-reveal>
                  <h3>Vault</h3>
                  <p>
                    Envelope encryption (AES-256-GCM, a versioned key ring) with the key file
                    outside the database, so a backup alone reveals nothing. The console shows a
                    hint like <span className="mono">****d87d</span>, never the key.
                  </p>
                </div>
                <div className="card" data-reveal>
                  <h3>ARC keys and accounts</h3>
                  <p>
                    ARC keys are stored as hashes, scoped, rotatable with an overlap window and
                    revocable at once. Two-step sign-in, Google sign-in with PKCE, strict session
                    cookies.
                  </p>
                </div>
                <div className="card" data-reveal>
                  <h3>Isolation and headers</h3>
                  <p>
                    Tenants never see each other’s data; customer base URLs are guarded against
                    internal addresses. A same-origin content security policy, HSTS and no framing.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section data-shot="8" className="block">
            <div className="wrap">
              <div className="cards two">
                <div className="card" data-reveal>
                  <span className="eyebrow">Operations</span>
                  <h3 style={{ marginTop: 12 }}>Built to be run, not just demoed.</h3>
                  <ul>
                    <li>
                      Health and readiness: <span className="mono">/healthz</span>,{' '}
                      <span className="mono">/readyz</span>
                    </li>
                    <li>
                      Prometheus metrics for overhead, time to first byte, fallbacks and rate limits
                    </li>
                    <li>Alertmanager emails when something goes wrong, and when it recovers</li>
                    <li>Nightly encrypted backups, an off-site copy and a timed restore drill</li>
                    <li>Controlled deploys with a dry run and automatic rollback</li>
                    <li>A load-test gate in CI: overhead p95 ≤ 30 ms, errors ≤ 1%</li>
                  </ul>
                </div>
                <div className="card" data-reveal>
                  <span className="eyebrow">Hosting</span>
                  <h3 style={{ marginTop: 12 }}>The whole stack on one free Arm VM.</h3>
                  <dl className="spec">
                    <dt>Compute</dt>
                    <dd>Oracle Cloud VM.Standard.A1.Flex: 4 Ampere cores, 24 GB</dd>
                    <dt>Runtime</dt>
                    <dd>Docker Compose: API, worker, PostgreSQL, Redis, LiteLLM, Caddy</dd>
                    <dt>Needs</dt>
                    <dd>About 2–3 GB of memory with two LiteLLM workers</dd>
                    <dt>Cost</dt>
                    <dd>$0 on the Always Free tier, guarded by a $1 budget alert</dd>
                  </dl>
                  <p>
                    <a href={DOC('docs/deploy-oracle.md')} target="_blank" rel="noreferrer">
                      Deploy your own in about an hour
                    </a>
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section data-shot="8.5" id="sky" className="block">
            <div className="wrap">
              <div className="block-head">
                <div>
                  <span className="eyebrow">The sky, explained</span>
                  <h2 className="h2" data-words>
                    <Words text="Every light up there follows real physics." />
                  </h2>
                </div>
                <p className="lead" data-reveal>
                  The stars, the galaxy, the sunlight and the air are modelled from real catalogues
                  and real optics. Two things are not to scale: objects in orbit are enlarged and
                  sped up so you can see them, and the requests are a picture of routing.
                </p>
              </div>
              <div className="cards">
                {PHYSICS.map((c) => (
                  <div className="card" data-reveal key={c.title}>
                    <h3>{c.title}</h3>
                    <p className="eq mono">{c.eq}</p>
                    <p>{c.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section data-shot="9" className="wrap closing">
            <h2 className="display" data-words>
              <Words text="Your apps. Every provider. One runtime." />
            </h2>
            <p className="lead" data-reveal style={{ marginTop: 22 }}>
              Create an app, issue a key, and send your first request in minutes.
            </p>
            <div className="ctas" data-reveal>
              {tryButton(true)}
              <a className="btn lg" href={REPO} target="_blank" rel="noreferrer">
                Self-host from GitHub
              </a>
            </div>
          </section>
        </main>

        <footer>
          <div className="wrap">
            <div>
              <Wordmark height={20} />
              <p className="muted" style={{ fontSize: 14, marginTop: 14 }}>
                AI Runtime &amp; Connectivity. Apache 2.0.
              </p>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                Earth imagery:{' '}
                <a
                  href="https://www.solarsystemscope.com/textures/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Solar System Scope
                </a>{' '}
                (CC BY 4.0), from NASA data. Stars and Milky Way: Hipparcos (ESA) and the Milky Way
                Outline Catalog, via{' '}
                <a href="https://github.com/ofrohn/d3-celestial" target="_blank" rel="noreferrer">
                  d3-celestial
                </a>
                .
              </p>
            </div>
            <div>
              <h4>Product</h4>
              <ul>
                <li>
                  <a href="/dashboard/" onClick={tryNow}>
                    Try now
                  </a>
                </li>
                <li>
                  <a href="/dashboard/">Sign in</a>
                </li>
                <li>
                  <a href="/console/">Owner console</a>
                </li>
              </ul>
            </div>
            <div>
              <h4>Developers</h4>
              <ul>
                <li>
                  <a href={DOC('docs/inference-api.md')} target="_blank" rel="noreferrer">
                    Inference API
                  </a>
                </li>
                <li>
                  <a href={DOC('docs/app-integration.md')} target="_blank" rel="noreferrer">
                    App integration
                  </a>
                </li>
                <li>
                  <a href={DOC('docs/admin-api.md')} target="_blank" rel="noreferrer">
                    Admin API
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h4>Operate</h4>
              <ul>
                <li>
                  <a href={DOC('docs/deploy-oracle.md')} target="_blank" rel="noreferrer">
                    Deploy on Oracle
                  </a>
                </li>
                <li>
                  <a href={DOC('docs/operations.md')} target="_blank" rel="noreferrer">
                    Operations
                  </a>
                </li>
                <li>
                  <a href={DOC('docs/threat-model.md')} target="_blank" rel="noreferrer">
                    Threat model
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h4>Project</h4>
              <ul>
                <li>
                  <a href={REPO} target="_blank" rel="noreferrer">
                    GitHub
                  </a>
                </li>
                <li>
                  <a href={DOC('docs/providers.md')} target="_blank" rel="noreferrer">
                    Providers
                  </a>
                </li>
                <li>
                  <a href={DOC('docs/plan.md')} target="_blank" rel="noreferrer">
                    Roadmap
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
