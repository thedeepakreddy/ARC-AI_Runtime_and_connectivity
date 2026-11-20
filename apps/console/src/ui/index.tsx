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
function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}
function useFocusFirst(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(
      'input, select, textarea, button:not(.btn.icon)',
    );
    el?.focus();
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
  useFocusFirst(ref);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-modal="true" ref={ref}>
        <div className="sheet-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="sheet-title">{title}</h2>
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
      </aside>
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
  useFocusFirst(ref);
  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="dialog" role="dialog" aria-modal="true" ref={ref}>
        <div className="sheet-head">
          <h2 className="sheet-title">{title}</h2>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </>
  );
}
export function Menu({
  items,
}: {
  items: ({ label: string; onSelect: () => void; danger?: boolean } | 'sep')[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div style={{ position: 'relative' }} ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        className="btn ghost icon"
        aria-label="Actions"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it, i) =>
            it === 'sep' ? (
              <hr key={i} />
            ) : (
              <button
                key={it.label}
                role="menuitem"
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

/* ---------- Chart: requests over time, errors as a second line ---------- */
export function TrafficChart({
  points,
  height = 160,
  label,
}: {
  points: { t: string; requests: number; errors: number }[];
  height?: number;
  label: (iso: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = 1000;
  const H = height;
  const pad = { t: 10, b: 22 };
  const max = Math.max(1, ...points.map((p) => p.requests));
  const nice = useMemo(() => {
    const mag = 10 ** Math.floor(Math.log10(max));
    return Math.ceil(max / mag) * mag;
  }, [max]);
  const x = (i: number) => (points.length <= 1 ? 0 : (i / (points.length - 1)) * W);
  const y = (v: number) => pad.t + (1 - v / nice) * (H - pad.t - pad.b);
  const line = (key: 'requests' | 'errors') =>
    points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
  const area = `${line('requests')}L${W},${H - pad.b}L0,${H - pad.b}Z`;
  const gid = useId().replace(/:/g, '');
  const ticks = points.length ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : [];
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };
  const hp = hover !== null ? points[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        width="100%"
        height={H}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="Requests and errors over time"
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--horizon)" stopOpacity="0.22" />
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
            strokeDasharray="2 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <line
          x1="0"
          x2={W}
          y1={H - pad.b}
          y2={H - pad.b}
          stroke="var(--line-strong)"
          vectorEffect="non-scaling-stroke"
        />
        <path d={area} fill={`url(#${gid})`} />
        <path
          d={line('requests')}
          fill="none"
          stroke="var(--horizon)"
          strokeWidth="1.75"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
        <path
          d={line('errors')}
          fill="none"
          stroke="var(--bad)"
          strokeWidth="1.25"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          opacity="0.85"
        />
        {hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={pad.t}
            y2={H - pad.b}
            stroke="var(--text-3)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: `auto 0 0 0`,
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11.5,
          color: 'var(--text-3)',
        }}
      >
        {ticks.map((i) => (
          <span key={i}>{label(points[i]!.t)}</span>
        ))}
      </div>
      <div
        style={{ position: 'absolute', top: 0, right: 0, fontSize: 11.5, color: 'var(--text-3)' }}
        className="num"
      >
        {nice.toLocaleString()}
      </div>
      {hp && (
        <div
          className="num"
          style={{
            position: 'absolute',
            top: 8,
            left: `clamp(0px, calc(${(x(hover!) / W) * 100}% - 70px), calc(100% - 150px))`,
            padding: '6px 10px',
            borderRadius: 8,
            background: 'var(--surface)',
            boxShadow: 'var(--shadow-pop)',
            fontSize: 12.5,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          <div className="faint">{label(hp.t)}</div>
          {hp.requests.toLocaleString()} requests · {hp.errors.toLocaleString()} errors
        </div>
      )}
    </div>
  );
}
