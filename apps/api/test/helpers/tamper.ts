/** Change the last character to a different one (never a no-op, unlike always appending "x"). */
export function tamperLastChar(value: string): string {
  const last = value.at(-1);
  return value.slice(0, -1) + (last === 'x' ? 'y' : 'x');
}
