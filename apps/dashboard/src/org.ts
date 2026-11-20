import { createContext, useContext } from 'react';

/** The organization the dashboard is acting for, and what the signed-in user may do in it. */
export interface Org {
  id: string;
  name: string;
  kind: string;
  role: 'owner' | 'admin' | 'member';
  /** Admins and owners manage apps, keys and invitations. */
  canManage: boolean;
  isOwner: boolean;
  /** Re-read the user's organizations (after a rename, leaving, joining). */
  reload: () => void;
}

export const OrgContext = createContext<Org | null>(null);

export function useOrg(): Org {
  const org = useContext(OrgContext);
  if (!org) throw new Error('useOrg outside OrgContext');
  return org;
}

export const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

export const ROLE_HELP: Record<string, string> = {
  owner: 'Everything, including the team, regions and the organization itself.',
  admin: 'Apps, ARC keys, provider keys and inviting people.',
  member: 'Sees apps, keys and usage. Can’t change them.',
};

/** Where apps send requests: this ARC's OpenAI-compatible API. */
export const apiBaseUrl = () => `${location.origin}/v1`;
