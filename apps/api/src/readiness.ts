export interface DependencyCheck {
  readonly name: string;
  /** Resolve when healthy, reject when not. Must honour the abort signal. */
  check(signal: AbortSignal): Promise<void>;
}

export type DependencyStatus =
  | { name: string; status: 'up'; latencyMs: number }
  | { name: string; status: 'down' | 'timeout'; latencyMs: number; error: string };

export interface ReadinessReport {
  ready: boolean;
  dependencies: DependencyStatus[];
}

class CheckTimeoutError extends Error {}

async function runOne(dep: DependencyCheck, timeoutMs: number): Promise<DependencyStatus> {
  const controller = new AbortController();
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first so the timeout wins the race, then cancel the check.
      reject(new CheckTimeoutError());
      controller.abort();
    }, timeoutMs);
  });
  try {
    await Promise.race([dep.check(controller.signal), timeout]);
    return { name: dep.name, status: 'up', latencyMs: elapsed(started) };
  } catch (err) {
    const timedOut = err instanceof CheckTimeoutError;
    return {
      name: dep.name,
      status: timedOut ? 'timeout' : 'down',
      latencyMs: elapsed(started),
      // Only the error class/message, never connection strings or credentials.
      error: timedOut ? `exceeded ${timeoutMs}ms` : safeMessage(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Run all checks in parallel, each bounded by its own timeout. */
export async function checkReadiness(
  deps: readonly DependencyCheck[],
  timeoutMs: number,
): Promise<ReadinessReport> {
  const dependencies = await Promise.all(deps.map((d) => runOne(d, timeoutMs)));
  return { ready: dependencies.every((d) => d.status === 'up'), dependencies };
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function safeMessage(err: unknown): string {
  if (err instanceof Error) {
    // Strip anything that looks like a URL with credentials.
    return err.message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]*/gi, '<url>').slice(0, 200);
  }
  return 'unknown error';
}
