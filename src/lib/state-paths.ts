// m16 ops-2: the single source of truth for where Relay's durable state lives on disk. Both the
// runtime (src/index.ts) and the `relay status` CLI (scripts/status.mjs) resolve store paths through
// here, so the CLI reads EXACTLY what the runtime writes — no path drift. Each store file is a
// JSON `{ v: 1, items: [...] }` document (see ScheduleStore/RecipeStore/DigestStore/AlertStore).
//
// Paths are env-overridable (a deploy can relocate the data dir) with the historical defaults under
// data/. Resolved at call time so a test/CLI can set the env before reading.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

export interface StatePaths {
  memory: string;
  schedules: string;
  recipes: string;
  digests: string;
  alerts: string;
  metrics: string;
  profile: string;
}

/** Resolve all durable-state file paths from env (with the data/ defaults). */
export function statePaths(env: NodeJS.ProcessEnv = process.env): StatePaths {
  return {
    memory: env.RELAY_MEMORY_FILE ?? "data/relay-memory.json",
    schedules: env.RELAY_SCHEDULE_FILE ?? "data/relay-schedules.json",
    recipes: env.RELAY_RECIPE_FILE ?? "data/relay-recipes.json",
    digests: env.RELAY_DIGEST_FILE ?? "data/relay-digests.json",
    alerts: env.RELAY_ALERT_FILE ?? "data/relay-alerts.json",
    metrics: env.RELAY_METRICS_FILE ?? "data/relay-metrics.json",
    profile: env.RELAY_PROFILE_FILE ?? "data/relay-profile.json",
  };
}

/**
 * Read the `items` array from a `{ v, items: [] }` store file. A missing file, unreadable file, or
 * corrupt/unexpected JSON all yield `[]` — never throws. This is the read side the CLI shares with
 * every store's own `load()`, so `relay status` counts exactly what the runtime persisted.
 */
export function readStoreItems<T = unknown>(file: string): T[] {
  try {
    if (!existsSync(file)) return [];
    const obj = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(obj?.items) ? (obj.items as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * Persist a metrics snapshot so `relay status` can show the last known health window without the
 * bot running (ops-3). Best-effort — a write failure is swallowed (metrics are observability, never
 * worth crashing the worker). Shape: `{ v: 1, at: <epoch ms>, summary: {...} }`.
 */
export function writeMetricsSnapshot(file: string, summary: unknown, nowMs: number): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ v: 1, at: nowMs, summary }), "utf8");
  } catch {
    /* best-effort */
  }
}

/** Read the metrics snapshot ({v,at,summary}) written by writeMetricsSnapshot. null if absent/corrupt. */
export function readMetricsSnapshot(file: string): { at: number; summary: unknown } | null {
  try {
    if (!existsSync(file)) return null;
    const obj = JSON.parse(readFileSync(file, "utf8"));
    if (obj && typeof obj.at === "number") return { at: obj.at, summary: obj.summary };
    return null;
  } catch {
    return null;
  }
}
