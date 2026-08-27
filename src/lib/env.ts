// Shared numeric-env parsing (DEV-0163). A bare `Number(envVar ?? default)` is a recurring
// footgun in this codebase: a typo yields NaN, and downstream comparisons silently break the feature
// — a NaN timer period never fires (scheduled reminders die), a NaN rate limit fails open, a NaN
// step budget dead-locks the agent. intEnv resolves to a valid clamped integer or the fallback,
// NEVER NaN. See DEV-0161 (max-steps), DEV-0162 (rate-limit, fail-safe), DEV-0163 (timers).

export interface IntEnvOpts {
  fallback: number;          // used for undefined / blank / NaN / below-min
  min?: number;              // clamp floor (default 0)
  max?: number;              // optional clamp ceiling
  allowZeroDisable?: boolean; // when true, a literal 0 is honored (feature-disable); else 0 → fallback
}

/**
 * Parse an env string to a safe integer. Blank/unset/garbage → fallback (Number("") is 0, which would
 * wrongly read as an explicit 0, so blank is treated as unset). A finite value is floored and clamped
 * to [min, max]. A literal 0 is kept only when allowZeroDisable is set (it means "disable"); otherwise
 * 0 (and anything below min) falls back so a feature can't be silently turned off by a bad value.
 */
export function intEnv(raw: string | undefined, opts: IntEnvOpts): number {
  const { fallback, min = 0, max, allowZeroDisable = false } = opts;
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  if (n === 0) return allowZeroDisable ? 0 : fallback; // a literal 0 disables only when allowed
  if (n < min) return fallback;
  if (max !== undefined && n > max) return max;
  return n;
}
