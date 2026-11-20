import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

/* ---------- Icons: a small, consistent 16px stroke set ---------- */
const paths: Record<string, ReactNode> = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  chevron: <path d="m6 4 4 4-4 4" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r=".9" fill="currentColor" />
      <circle cx="8" cy="8" r=".9" fill="currentColor" />
      <circle cx="12.5" cy="8" r=".9" fill="currentColor" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" />
      <path d="M10.5 3.5v-.2A1.3 1.3 0 0 0 9.2 2H3.8A1.3 1.3 0 0 0 2.5 3.3v5.4A1.3 1.3 0 0 0 3.8 10h.2" />
    </>
  ),
  check: <path d="m3.5 8.5 3 3 6-7" />,
  arrow: <path d="M3 8h10m-4-4 4 4-4 4" />,
  menu: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />,
  alert: (
    <>
      <path d="M8 2.2 14.3 13H1.7Z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.3" r=".5" fill="currentColor" />
    </>
  ),
};
export function Icon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

/* ---------- Status ---------- */
export function Dot({ tone }: { tone: string }) {
  return <span className={`dot ${tone}`} aria-hidden="true" />;
}
export function Status({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className="status">
      <Dot tone={tone} />
      {children}
    </span>
  );
}
export function Badge({ tone = '', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

/* ---------- Layout ---------- */
export function PageHead({
  title,
  sub,
  crumb,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode;
  crumb?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {crumb && <div className="crumb">{crumb}</div>}
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </header>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}
export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="panel panel-pad" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${88 - i * 13}%`, margin: '10px 0' }} />
      ))}
    </div>
  );
}
export function ErrorNote({ error }: { error: Error | null }) {
  if (!error) return null;
  return <div className="note bad">{error.message}</div>;
}

/* ---------- Controls ---------- */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      aria-description={disabled ? title : undefined}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    />
  );
}
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}
export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
}: {
  value: T;
  tabs: { id: T; label: string; count?: number }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="count num">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search">
      <Icon name="search" size={14} />
      <span className="sr-only">{placeholder}</span>
      <input
        className="input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? (
        <span className="error-text">{error}</span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  );
}
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={14} />
      {done ? 'Copied' : label}
    </button>
  );
}

/* ---------- Overlays ---------- */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}
/**
 * Modal focus: move focus in (first field, else the first control that isn't the close button),
 * keep Tab inside, and give focus back to whatever opened the layer when it closes.
 */
function useModalFocus(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (!root) return;
    const first =
      root.querySelector<HTMLElement>('input, select, textarea') ??
      root.querySelector<HTMLElement>('button:not(.btn.icon)') ??
      root.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? root).focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      if (!items.length) return;
      const a = items[0]!;
      const z = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    root.addEventListener('keydown', trap);
    return () => {
      root.removeEventListener('keydown', trap);
      if (opener?.isConnected) opener.focus();
    };
  }, [ref]);
}
export function Sheet({
  title,
  sub,
  onClose,
  footer,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  useEscape(onClose);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalFocus(ref);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
      >
        <div className="sheet-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="sheet-title" id={titleId}>
              {title}
            </h2>
            {sub && (
              <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
                {sub}
              </div>
            )}
          </div>
          <button className="btn ghost icon" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </>
  );
}
export function Dialog({
  title,
  onClose,
  footer,
  children,
  dismissable = true,
}: {
  title: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  dismissable?: boolean;
}) {
  const close = useCallback(() => dismissable && onClose(), [dismissable, onClose]);
  useEscape(close);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalFocus(ref);
  return (
    <>
      <div className="scrim" onClick={close} />
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
      >
        <div className="sheet-head">
          <h2 className="sheet-title" id={titleId}>
            {title}
          </h2>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </>
  );
}
/** Action menu (WAI-ARIA menu button): focus moves in, arrows move, Escape returns. */
export function Menu({
  items,
  label = 'Actions',
}: {
  items: ({ label: string; onSelect: () => void; danger?: boolean } | 'sep')[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', h);
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const list = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => list[(n + list.length) % list.length]?.focus();
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Tab') setOpen(false);
    else return;
    if (e.key !== 'Tab') e.preventDefault();
  };
  return (
    <div style={{ position: 'relative' }} ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        ref={button}
        className="btn ghost icon"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu" role="menu" id={menuId} aria-label={label} onKeyDown={onKeyDown}>
          {items.map((it, i) =>
            it === 'sep' ? (
              <hr key={i} role="separator" />
            ) : (
              <button
                key={it.label}
                role="menuitem"
                tabIndex={-1}
                className={it.danger ? 'danger' : ''}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** A confirmation for destructive or consequential actions. */
export function Confirm({
  title,
  body,
  action,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  action: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                setErr((e as Error).message);
                setBusy(false);
              }
            }}
          >
            {action}
          </button>
        </>
      }
    >
      <div className="muted">{body}</div>
      {err && <p className="error-text">{err}</p>}
    </Dialog>
  );
}

/* ---------- Toasts ---------- */
type Toast = { id: number; text: string; bad?: boolean };
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, bad?: boolean) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, text, ...(bad ? { bad } : {}) }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`toast ${t.bad ? 'bad' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ---------- Chart: requests over time, errors on their own strip ---------- */
/*
 * Requests and errors differ by two orders of magnitude, so they never share an axis (the
 * errors line would sit flat on the baseline). Requests get the main plot; errors get a short
 * strip below with its own scale. One crosshair and tooltip covers both.
 */
export function TrafficChart({
  points,
  height = 160,
  label,
  action,
}: {
  points: { t: string; requests: number; errors: number }[];
  height?: number;
  label: (iso: string) => string;
  action?: ReactNode;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const W = 1000;
  const H = height;
  const EH = 40;
  const niceOf = (m: number) => {
    const mag = 10 ** Math.floor(Math.log10(Math.max(1, m)));
    return Math.max(1, Math.ceil(m / mag) * mag);
  };
  const totals = useMemo(
    () =>
      points.reduce(
        (a, p) => ({
          requests: a.requests + p.requests,
          errors: a.errors + p.errors,
          peak: Math.max(a.peak, p.requests),
          errPeak: Math.max(a.errPeak, p.errors),
        }),
        { requests: 0, errors: 0, peak: 0, errPeak: 0 },
      ),
    [points],
  );
  const nice = niceOf(totals.peak);
  const errNice = niceOf(totals.errPeak);
  const x = (i: number) => (points.length <= 1 ? 0 : (i / (points.length - 1)) * W);
  const y = (v: number) => 6 + (1 - v / nice) * (H - 6);
  const ey = (v: number) => 4 + (1 - v / errNice) * (EH - 4);
  const path = (f: (p: (typeof points)[number]) => number, yy: (v: number) => number) =>
    points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yy(f(p)).toFixed(1)}`).join('');
  const reqLine = path((p) => p.requests, y);
  const errLine = path((p) => p.errors, ey);
  const gid = useId().replace(/:/g, '');
  const ticks = points.length ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : [];
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };
  const hp = hover !== null ? points[hover] : null;
  const pctX = hover !== null ? (x(hover) / W) * 100 : 0;
  const summary = points.length
    ? `Requests from ${label(points[0]!.t)} to ${label(points[points.length - 1]!.t)}: ` +
      `${totals.requests.toLocaleString()} in total, peak ${totals.peak.toLocaleString()}; ` +
      `${totals.errors.toLocaleString()} errors, peak ${totals.errPeak.toLocaleString()}.`
    : 'No traffic in this period.';
  return (
    <figure className="tchart">
      <figcaption className="sr-only">{summary}</figcaption>
      <div className="tchart-head">
        <span aria-hidden="true">Requests</span>
        {action}
      </div>
      <div
        ref={ref}
        className="tchart-plots"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        aria-hidden="true"
      >
        <span className="tchart-scale num" style={{ top: y(nice) }}>
          {nice.toLocaleString()}
        </span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--horizon)" stopOpacity="0.28" />
              <stop offset="1" stopColor="var(--horizon)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.5, 1].map((f) => (
            <line
              key={f}
              x1="0"
              x2={W}
              y1={y(nice * f)}
              y2={y(nice * f)}
              stroke="var(--line)"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path d={`${reqLine}L${W},${H}L0,${H}Z`} fill={`url(#${gid})`} />
          <path
            d={reqLine}
            fill="none"
            stroke="var(--horizon)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        <div className="tchart-sub">
          <span>Errors</span>
          <span className="num">{errNice.toLocaleString()}</span>
        </div>
        <svg viewBox={`0 0 ${W} ${EH}`} preserveAspectRatio="none" width="100%" height={EH}>
          <line
            x1="0"
            x2={W}
            y1={EH}
            y2={EH}
            stroke="var(--line-strong)"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={errLine}
            fill="none"
            stroke="var(--bad)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        {hp && (
          <>
            <span className="tchart-cross" style={{ left: `${pctX}%` }} />
            <span className="tchart-dot" style={{ left: `${pctX}%`, top: y(hp.requests) }} />
            <div
              className="tchart-tip num"
              style={{ left: `clamp(0px, calc(${pctX}% - 80px), calc(100% - 172px))` }}
            >
              <div className="faint">{label(hp.t)}</div>
              <div>
                <strong>{hp.requests.toLocaleString()}</strong> requests
              </div>
              <div>
                <strong>{hp.errors.toLocaleString()}</strong> errors
              </div>
            </div>
          </>
        )}
      </div>
      <div className="tchart-axis" aria-hidden="true">
        {ticks.map((i) => (
          <span key={i}>{label(points[i]!.t)}</span>
        ))}
      </div>
    </figure>
  );
}

export { Wordmark } from './Wordmark';
