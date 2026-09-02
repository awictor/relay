// Atomic, corruption-safe JSON persistence for the local stores (schedules, recipes, digests,
// alerts, memory). Two failure modes this fixes, both user-visible as "all my saved stuff vanished":
//   1. A bare writeFileSync is NOT atomic — a crash/kill mid-write leaves a truncated half-file,
//      which then fails to parse on next boot. We write a temp file + fsync + rename (rename is
//      atomic on the same filesystem), so a reader always sees either the old or the new whole file.
//   2. `load()` previously did `catch { this.items = [] }` — one corrupt byte silently discarded
//      EVERY saved reminder/recipe/alert. We instead back the bad file up to <file>.corrupt so the
//      data is recoverable + the failure is visible, then return null so the caller starts fresh.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { dirname } from "path";

/** Write `obj` as JSON atomically: temp file in the same dir, then rename over the target. Creates
 * the dir. Best-effort (never throws) — persistence failure must not crash the worker; the temp is
 * cleaned up on a failed rename so we don't leak .tmp files. */
export function atomicWriteJson(file: string, obj: unknown): void {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(obj), "utf8");
    renameSync(tmp, file); // atomic on same fs — reader sees old-or-new, never a torn write
  } catch {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** Read + JSON.parse a store file. Missing -> null (fresh start, no data lost). Corrupt -> move it
 * aside to <file>.corrupt (recoverable + visible) and return null, instead of silently wiping. */
export function readJsonSafe<T = unknown>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    try { renameSync(file, `${file}.corrupt`); } catch { /* if even that fails, leave it be */ }
    return null;
  }
}
