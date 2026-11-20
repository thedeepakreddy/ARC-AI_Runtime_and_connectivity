import { ErrorNote, Field, PageHead, useToast } from '@arc/ui';
import { type Policy, api } from '@arc/ui/api';
import { useData } from '@arc/ui/hooks';
import { useState } from 'react';
import { useOrg } from '../org';
import { RegionChecklist } from '../regions';

export function SettingsPage() {
  const org = useOrg();
  return (
    <div className="page narrow">
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
  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Regions</h2>
      </div>
      <div className="panel panel-pad">
        <p className="muted mt-0">
          ARC only sends your requests to providers based in the regions you allow. Keys from other
          regions stay saved but unused. An app can have its own rule instead, on its page.
        </p>
        <ErrorNote error={policy.error} />
        {policy.data && (
          <RegionChecklist
            current={policy.data.allowedJurisdictions}
            canEdit={org.isOwner}
            onSave={async (allowedJurisdictions) => {
              try {
                await api('PUT', '/routing/policy', {
                  allowedJurisdictions,
                  allowPaidOwnerKeys: false,
                });
                toast('Regions saved');
                void policy.reload();
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          />
        )}
        {!org.isOwner && <p className="hint mb-0">Only owners can change regions.</p>}
      </div>
    </section>
  );
}
