const nf = new Intl.NumberFormat();
export const num = (n: number) => nf.format(n);
export const compact = (n: number) =>
  n >= 10_000
    ? new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
    : nf.format(n);
export const pct = (r: number) => {
  if (!r) return '0%';
  const v = r * 100;
  return `${v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v)}%`;
};
export const ms = (v: number | null | undefined) =>
  v === null || v === undefined
    ? '—'
    : v < 10
      ? `${v.toFixed(1)} ms`
      : v < 1000
        ? `${Math.round(v)} ms`
        : `${(v / 1000).toFixed(2)} s`;

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const a = Math.abs(s);
  if (a < 45) return s <= 0 ? 'just now' : 'in a moment';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return date(iso);
}
export const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export const JURISDICTIONS: Record<string, string> = {
  US: 'United States',
  EU: 'European Union',
  UK: 'United Kingdom',
  CA: 'Canada',
  CN: 'China',
  SELF_HOSTED: 'Self-hosted',
};
export const ELIGIBILITY: Record<string, { label: string; tone: string; help: string }> = {
  VERIFIED_FREE: {
    label: 'Free',
    tone: 'ok',
    help: 'Free to use, confirmed on the provider’s pricing page.',
  },
  RESTRICTED_FREE: {
    label: 'Restricted free',
    tone: 'warn',
    help: 'Free within the provider’s terms, such as daily limits. Used only within them.',
  },
  PAID: {
    label: 'Paid',
    tone: 'bad',
    help: 'Costs money. Used only where you have approved paid use.',
  },
  UNKNOWN: { label: 'Unknown', tone: '', help: 'Not classified yet. Never used.' },
};
export const CAPABILITIES: [string, string][] = [
  ['text', 'Text'],
  ['streaming', 'Streaming'],
  ['tools', 'Tools'],
  ['structured_output', 'JSON output'],
  ['vision', 'Images'],
  ['documents', 'Documents'],
  ['audio_input', 'Audio in'],
  ['audio_output', 'Audio out'],
  ['transcription', 'Transcription'],
  ['speech', 'Speech'],
  ['video', 'Video'],
  ['embeddings', 'Embeddings'],
];
export const capLabel = (c: string) => CAPABILITIES.find(([k]) => k === c)?.[1] ?? c;
export const HEALTH: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'off' | '' }> = {
  healthy: { label: 'Healthy', tone: 'ok' },
  rate_limited: { label: 'Resting', tone: 'warn' },
  invalid_credentials: { label: 'Rejected', tone: 'bad' },
  unreachable: { label: 'Unreachable', tone: 'bad' },
  unsupported: { label: 'Unsupported', tone: 'bad' },
  unknown: { label: 'Not checked', tone: '' },
};
export const GROUPS: Record<string, string> = {
  core: 'Core',
  international: 'International',
  chinese: 'Chinese',
  local: 'Local',
  speech_embeddings: 'Speech & embeddings',
};
