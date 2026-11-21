/**
 * The name of a new person's own workspace (an organization they own) when they don't give one:
 * "Maya's workspace" for maya.lee+test@example.com. They can rename it in Settings.
 */
export function defaultWorkspaceName(email: string): string {
  const local = email.split('@')[0]!.split('+')[0]!;
  const first = local.split(/[._-]/).find((p) => /[a-z]/i.test(p)) ?? '';
  const word = first.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40);
  return word ? `${word[0]!.toUpperCase()}${word.slice(1)}'s workspace` : 'My workspace';
}
