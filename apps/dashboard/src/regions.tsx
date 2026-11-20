import { JURISDICTIONS } from '@arc/ui/format';
import { useEffect, useState } from 'react';

const ALL = Object.keys(JURISDICTIONS);

/**
 * Region checkboxes with a save button, shared by Settings (the organization's rule) and an
 * app's page (a rule for that app only). `null` means every region.
 */
export function RegionChecklist({
  current,
  canEdit,
  onSave,
  saveLabel = 'Save regions',
}: {
  current: string[] | null;
  canEdit: boolean;
  onSave: (allowed: string[] | null) => Promise<void>;
  saveLabel?: string;
}) {
  const [allowed, setAllowed] = useState<Set<string>>(() => new Set(current ?? ALL));
  const [busy, setBusy] = useState(false);
  useEffect(() => setAllowed(new Set(current ?? ALL)), [current]);
  const base = new Set(current ?? ALL);
  const changed = allowed.size !== base.size || [...allowed].some((j) => !base.has(j));
  return (
    <>
      <fieldset className="plain-fieldset" disabled={!canEdit}>
        <legend className="sr-only">Allowed regions</legend>
        <div className="region-grid">
          {ALL.map((j) => (
            <label key={j} className="check">
              <input
                type="checkbox"
                checked={allowed.has(j)}
                onChange={(e) => {
                  const n = new Set(allowed);
                  if (e.target.checked) n.add(j);
                  else n.delete(j);
                  setAllowed(n);
                }}
              />
              {JURISDICTIONS[j]}
            </label>
          ))}
        </div>
      </fieldset>
      {allowed.size === 0 && (
        <p className="error-text">Allow at least one region, or requests can’t reach any model.</p>
      )}
      {canEdit && (
        <button
          className="btn primary mt-16"
          disabled={!changed || allowed.size === 0 || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(allowed.size === ALL.length ? null : [...allowed]);
            } finally {
              setBusy(false);
            }
          }}
        >
          {saveLabel}
        </button>
      )}
    </>
  );
}

/** "United States, European Union" or "Every region". */
export const describeRegions = (list: string[] | null) =>
  list === null || list.length === ALL.length
    ? 'Every region'
    : list.map((j) => JURISDICTIONS[j] ?? j).join(', ');
