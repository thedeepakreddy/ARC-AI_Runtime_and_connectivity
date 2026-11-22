// Diagnostics for devices we can't test here (an iPad's Safari): what the sky is doing, shown in a
// panel when the address ends in ?debug=1. Nothing is sent anywhere; it's only drawn on the page.
export const skyDebug = {
  on: typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug'),
  tier: '',
  gpu: '',
  maxTexture: 0,
  frames: 0,
  loaded: [] as string[],
  failed: [] as string[],
  contextLost: 0,
  errors: [] as string[],
};

export function noteError(where: string, err: unknown): void {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  skyDebug.errors.push(`${where}: ${msg}`.slice(0, 300));
  if (skyDebug.errors.length > 12) skyDebug.errors.shift();
}
