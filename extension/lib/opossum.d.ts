/**
 * Ambient types for `opossum`, which ships no declarations.
 *
 * Only the surface this extension uses is declared: build a breaker in a
 * chosen state and read that state back. opossum's own OPEN/HALF_OPEN model is
 * what decides whether an aged loop streak earns a probe.
 */
declare module "opossum" {
  export interface CircuitBreakerOptions {
    /** Milliseconds before an OPEN circuit becomes HALF_OPEN. */
    resetTimeout?: number;
    errorThresholdPercentage?: number;
    volumeThreshold?: number;
    timeout?: number;
    /** Start in a given state instead of waiting for failures to accumulate. */
    state?: {
      enabled?: boolean;
      warmUp?: boolean;
      closed?: boolean;
      halfOpen?: boolean;
      open?: boolean;
      shutdown?: boolean;
    };
  }

  export default class CircuitBreaker<A extends unknown[] = unknown[], R = unknown> {
    constructor(action: (...args: A) => R, options?: CircuitBreakerOptions);
    readonly closed: boolean;
    readonly opened: boolean;
    readonly halfOpen: boolean;
    readonly enabled: boolean;
    open(): void;
    close(): void;
  }
}
