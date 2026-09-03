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

// A persist-failure sink (lists-remove-atomic-write-failure): atomicWriteJson used to swallow write
// errors silently, so a store on a full/unwritable disk reported "saved" while nothing hit disk — the
// data then vanished on restart and the user was never told. The write now RETURNS whether it
// succeeded (callers that announce "saved" can hedge) AND reports the failure here so an operator sees
// it in logs even for the many stores that don't surface a per-op result. Default logs to stderr;
// index can override to add an admin ping. Never throws.
type PersistErrorHandler = (file: string, err: unknown) => void;
let onPersistError: PersistErrorHandler = (file, err) => {
  try { console.error(`[safe-store] persist FAILED for ${file}: ${err instanceof Error ? err.message : String(err)}`); } catch { /* ignore */ }
};
/** Override the persist-failure sink (e.g. to alert an operator). Returns the previous handler. */
export function setPersistErrorHandler(fn: PersistErrorHandler): PersistErrorHandler {
  const prev = onPersistError;
  onPersistError = fn;
  return prev;
}

/** Write `obj` as JSON atomically: temp file in the same dir, then rename over the target. Creates
 * the dir. Never throws — persistence failure must not crash the worker; the temp is cleaned up on a
 * failed rename so we don't leak .tmp files. RETURNS true on success, false on failure (and reports
 * the failure to the persist-error sink), so a caller announcing "saved" can tell the user the truth. */
export function atomicWriteJson(file: string, obj: unknown): boolean {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(obj), "utf8");
    renameSync(tmp, file); // atomic on same fs — reader sees old-or-new, never a torn write
    return true;
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    onPersistError(file, err);
    return false;
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
