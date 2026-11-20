import { ErrorNote, Field, PageHead, useToast } from '@arc/ui';
import { type Policy, api } from '@arc/ui/api';
import { JURISDICTIONS } from '@arc/ui/format';
import { useData } from '@arc/ui/hooks';
import { useEffect, useState } from 'react';
import { useOrg } from '../org';

export function SettingsPage() {
  const org = useOrg();
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <PageHead title="Settings" sub={org.name} />
      <OrganizationName />
      {org.canManage && <Regions />}
    </div>
  );
}

function OrganizationName() {
  const org = useOrg();
  const toast = useToast();
  const [name, setName] = useState(org.name);
  const [error, setError] = useState<string | null>(null);
  return (
    <section>
      <div className="section-head">
        <h2 className="section-title">Organization</h2>
      </div>
      <form
        className="panel panel-pad"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api('PATCH', '/tenant', { name: name.trim() });
            toast('Name saved');
            org.reload();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <Field
          label="Name"
          error={error}
          hint={org.isOwner ? undefined : 'Only owners can rename the organization.'}
        >
          {(id) => (
            <input
              id={id}
              className="input"
              value={name}
              maxLength={200}
              disabled={!org.isOwner}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        {org.isOwner && (
          <button className="btn primary" disabled={!name.trim() || name.trim() === org.name}>
            Save
          </button>
        )}
      </form>
    </section>
  );
}

/** Which providers' jurisdictions this organization's requests may go to. */
function Regions() {
  const org = useOrg();
  const toast = useToast();
  const policy = useData<Policy>('/routing/policy');
  const [allowed, setAllowed] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (policy.data) {
      setAllowed(new Set(policy.data.allowedJurisdictions ?? Object.keys(JURISDICTIONS)));
    }
  }, [policy.data]);
  const all = Object.keys(JURISDICTIONS);
  const current = new Set(policy.data?.allowedJurisdictions ?? all);
  const changed =
    allowed !== null &&
    (allowed.size !== current.size || [...allowed].some((j) => !current.has(j)));

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Regions</h2>
      </div>
      <div className="panel panel-pad">
        <p className="muted" style={{ marginTop: 0 }}>
          ARC only sends your requests to providers based in the regions you allow. Keys from other
          regions stay saved but unused.
        </p>
        <ErrorNote error={policy.error} />
        {allowed && (
          <fieldset style={{ border: 0, margin: 0, padding: 0 }} disabled={!org.isOwner}>
            <legend className="sr-only">Allowed regions</legend>
            <div className="region-grid">
              {all.map((j) => (
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
        )}
        {allowed?.size === 0 && (
          <p className="error-text">
            Allow at least one region, or your apps can’t reach any model.
          </p>
        )}
        {org.isOwner ? (
          <button
            className="btn primary"
            style={{ marginTop: 16 }}
            disabled={!changed || allowed?.size === 0}
            onClick={async () => {
              try {
                await api('PUT', '/routing/policy', {
                  allowedJurisdictions: allowed!.size === all.length ? null : [...allowed!],
                  allowPaidOwnerKeys: false,
                });
                toast('Regions saved');
                void policy.reload();
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            Save regions
          </button>
        ) : (
          <p className="hint" style={{ marginBottom: 0 }}>
            Only owners can change regions.
          </p>
        )}
      </div>
    </section>
  );
}
