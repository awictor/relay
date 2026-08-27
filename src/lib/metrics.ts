// Rolling in-memory turn metrics for operator health without parsing every [out] line.
// Tracks totals, ok/fail, step + latency distributions, and a tool-use histogram.
// Latency percentiles come from a bounded ring buffer (last N samples) so memory is
// O(1). Pure/deterministic — unit-testable; no clock, no I/O.

const LATENCY_WINDOW = 500; // samples kept for percentiles

export interface MetricsSummary {
  turns: number;
  ok: number;
  fail: number;      // HARD failures only — a turn that threw (agent crashed / errored)
  degraded: number;  // soft failures — agent answered but ran low on steps / gave no answer (DEV-0179)
  avgSteps: number;
  p50Ms: number;
  p95Ms: number;
  tools: Record<string, number>;
  commands: Record<string, number>;
}

export class Metrics {
  private turns = 0;
  private okCount = 0;
  private failCount = 0;      // hard failures (a thrown/errored turn)
  private degradedCount = 0;  // soft failures (degraded reply — answered but partial)
  private stepSum = 0;
  private latencies: number[] = []; // ring buffer of recent elapsedMs
  private li = 0;
  private tools = new Map<string, number>();
  private commands = new Map<string, number>();

  /**
   * Record one slash-command invocation. Commands short-circuit before the agent, so they are NOT
   * counted by record()/turns — this histogram is a separate axis (which commands users actually
   * use), pure/deterministic like the tools histogram.
   */
  recordCommand(name: string): void {
    if (!name) return;
    this.commands.set(name, (this.commands.get(name) ?? 0) + 1);
  }

  /**
   * Record one completed turn. A not-ok turn splits into two classes (DEV-0179): a DEGRADED turn
   * (degraded:true — the agent answered but ran low on steps / gave no answer) increments degraded
   * only, and a HARD failure (ok:false with no degraded — the turn threw) increments fail only. This
   * lets an operator tell "producing partial answers" from "crashing"; turns == ok + fail + degraded.
   */
  record(turn: { steps: number; tools: string[]; elapsedMs: number; ok: boolean; degraded?: boolean }): void {
    this.turns++;
    if (turn.ok) this.okCount++;
    else if (turn.degraded) this.degradedCount++;
    else this.failCount++;
    this.stepSum += Math.max(0, turn.steps);
    const ms = Math.max(0, turn.elapsedMs);
    if (this.latencies.length < LATENCY_WINDOW) this.latencies.push(ms);
    else { this.latencies[this.li] = ms; this.li = (this.li + 1) % LATENCY_WINDOW; }
    for (const t of turn.tools) this.tools.set(t, (this.tools.get(t) ?? 0) + 1);
  }

  private percentile(p: number): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    // Nearest-rank: index = ceil(p/100 * n) - 1, clamped.
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Math.round(sorted[idx]!);
  }

  summary(): MetricsSummary {
    return {
      turns: this.turns,
      ok: this.okCount,
      fail: this.failCount,
      degraded: this.degradedCount,
      avgSteps: this.turns ? Math.round((this.stepSum / this.turns) * 10) / 10 : 0,
      p50Ms: this.percentile(50),
      p95Ms: this.percentile(95),
      tools: Object.fromEntries([...this.tools.entries()].sort((a, b) => b[1] - a[1])),
      commands: Object.fromEntries([...this.commands.entries()].sort((a, b) => b[1] - a[1])),
    };
  }

  /** One-line operator summary: `[metrics] {...}`. */
  format(): string {
    return `[metrics] ${JSON.stringify(this.summary())}`;
  }
}
