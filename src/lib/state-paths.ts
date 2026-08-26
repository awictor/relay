// m16 ops-2: the single source of truth for where Relay's durable state lives on disk. Both the
// runtime (src/index.ts) and the `relay status` CLI (scripts/status.mjs) resolve store paths through
// here, so the CLI reads EXACTLY what the runtime writes — no path drift. Each store file is a
// JSON `{ v: 1, items: [...] }` document (see ScheduleStore/RecipeStore/DigestStore/AlertStore).
//
// Paths are env-overridable (a deploy can relocate the data dir) with the historical defaults under
// data/. Resolved at call time so a test/CLI can set the env before reading.

import { readFileSync, existsSync } from "fs";

export interface StatePaths {
  memory: string;
  schedules: string;
  recipes: string;
  digests: string;
  alerts: string;
  metrics: string;
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
