/**
 * Route scoring: expected time to a successful first byte, in ms. Lower is better.
 * Priors keep new or rarely used keys competitive (so they get measured) and stop a handful
 * of samples from dominating. Pure function: used by the worker, testable in isolation.
 */
export const PRIOR_SUCCESS = 0.95;
export const PRIOR_SUCCESS_WEIGHT = 10;
export const PRIOR_TTFB_MS = 1500;
export const PRIOR_TTFB_WEIGHT = 5;
const FAILURE_PENALTY_MS = 2000;

export interface ObservationTotals {
  requests: number;
  successes: number;
  ttfbMsSum: number;
  ttfbSamples: number;
}

export interface RouteScore {
  samples: number;
  successRate: number;
  avgTtfbMs: number;
  expectedMs: number;
}

export function scoreRoute(t: ObservationTotals): RouteScore {
  const successRate =
    (t.successes + PRIOR_SUCCESS * PRIOR_SUCCESS_WEIGHT) / (t.requests + PRIOR_SUCCESS_WEIGHT);
  const avgTtfbMs =
    (t.ttfbMsSum + PRIOR_TTFB_MS * PRIOR_TTFB_WEIGHT) / (t.ttfbSamples + PRIOR_TTFB_WEIGHT);
  const expectedMs =
    avgTtfbMs / Math.max(successRate, 0.05) + (1 - successRate) * FAILURE_PENALTY_MS;
  return { samples: t.requests, successRate, avgTtfbMs, expectedMs };
}

/** Score for a route with no observations yet. */
export const NEUTRAL_EXPECTED_MS = scoreRoute({
  requests: 0,
  successes: 0,
  ttfbMsSum: 0,
  ttfbSamples: 0,
}).expectedMs;
