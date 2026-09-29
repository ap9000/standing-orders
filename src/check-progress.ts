/** Live facts extracted from the approved check's ordinary output. */
export const CHECK_SUITES = ["unit", "flows", "app"] as const;
export type CheckSuiteName = (typeof CHECK_SUITES)[number];
export type CheckSuiteState = "pending" | "running" | "passed" | "failed" | "unknown";

export type CheckSuiteProgress = {
  state: CheckSuiteState;
  passed: number;
  failed: number;
  skipped: number;
  total: number | null;
};

export type CheckProgressSnapshot = {
  version: 1;
  final: boolean;
  line: string;
  suites: Record<CheckSuiteName, CheckSuiteProgress>;
};

const emptySuite = (): CheckSuiteProgress => ({ state: "pending", passed: 0, failed: 0, skipped: 0, total: null });

function cleanLine(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function safeCount(raw: string | undefined): number | null {
  if (raw === undefined || !/^[0-9]{1,9}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function suiteWords(name: CheckSuiteName, suite: CheckSuiteProgress): string {
  const completed = suite.passed + suite.failed + suite.skipped;
  if (suite.state === "passed") {
    const count = suite.total !== null && suite.skipped > 0 ? `${suite.passed}/${suite.total}` : String(suite.passed);
    return `${name} ✓ ${count}`;
  }
  if (suite.state === "failed") {
    return `${name} ✕ ${suite.failed}${suite.total === null ? "" : `/${suite.total}`}`;
  }
  if (suite.state === "running") return `${name} ${completed}${suite.total === null ? "" : `/${suite.total}`}`;
  if (suite.state === "unknown") return `${name} ?${completed === 0 ? "" : ` ${completed}`}`;
  return `${name} …`;
}

export function checkProgressLine(suites: Record<CheckSuiteName, CheckSuiteProgress>): string {
  return CHECK_SUITES.map(name => suiteWords(name, suites[name])).join(" · ");
}

/** A machine-only count line that is safe to send through a push provider. */
export function isCheckProgressLine(value: string): boolean {
  return /^(?:unit|flows|app) (?:…|\?(?: [0-9]{1,9})?|[0-9]{1,9}(?:\/[0-9]{1,9})?|✓ [0-9]{1,9}(?:\/[0-9]{1,9})?|✕ [0-9]{1,9}(?:\/[0-9]{1,9})?)(?: · (?:unit|flows|app) (?:…|\?(?: [0-9]{1,9})?|[0-9]{1,9}(?:\/[0-9]{1,9})?|✓ [0-9]{1,9}(?:\/[0-9]{1,9})?|✕ [0-9]{1,9}(?:\/[0-9]{1,9})?)){2}$/.test(value);
}

export function parseCheckProgressSnapshot(raw: string): CheckProgressSnapshot | null {
  try {
    const value = JSON.parse(raw) as Partial<CheckProgressSnapshot>;
    if (value.version !== 1 || typeof value.final !== "boolean" || typeof value.line !== "string" || !isCheckProgressLine(value.line) || value.suites === null || typeof value.suites !== "object") return null;
    const suites = {} as Record<CheckSuiteName, CheckSuiteProgress>;
    for (const name of CHECK_SUITES) {
      const suite = value.suites[name] as Partial<CheckSuiteProgress> | undefined;
      if (suite === undefined || !["pending", "running", "passed", "failed", "unknown"].includes(String(suite.state))) return null;
      if (![suite.passed, suite.failed, suite.skipped].every(one => Number.isSafeInteger(one) && Number(one) >= 0)) return null;
      if (suite.total !== null && (!Number.isSafeInteger(suite.total) || Number(suite.total) < 0)) return null;
      const completed = Number(suite.passed) + Number(suite.failed) + Number(suite.skipped);
      if (suite.total !== null && completed > Number(suite.total)) return null;
      if (value.final && (suite.state === "pending" || suite.state === "running")) return null;
      suites[name] = { state: suite.state as CheckSuiteState, passed: Number(suite.passed), failed: Number(suite.failed), skipped: Number(suite.skipped), total: suite.total === null ? null : Number(suite.total) };
    }
    if (checkProgressLine(suites) !== value.line) return null;
    return { version: 1, final: value.final, line: value.line, suites };
  } catch {
    return null;
  }
}

/**
 * Incrementally reads stdout and stderr. Each stream keeps its own partial
 * line so simultaneous journey output cannot splice two records together.
 */
export class CheckProgressTracker {
  private readonly suites: Record<CheckSuiteName, CheckSuiteProgress> = {
    unit: emptySuite(),
    flows: emptySuite(),
    app: emptySuite(),
  };
  private readonly buffers = { stdout: "", stderr: "" };
  private readonly events = new Set<string>();
  private last = "";
  private recognized = false;

  constructor(private readonly update: (snapshot: CheckProgressSnapshot) => void) {}

  feed(chunk: string, stream: "stdout" | "stderr" = "stdout"): void {
    const joined = this.buffers[stream] + chunk;
    const lines = joined.split(/\n/);
    this.buffers[stream] = lines.pop() ?? "";
    for (const line of lines) this.read(line);
  }

  finish(): CheckProgressSnapshot | null {
    for (const stream of ["stdout", "stderr"] as const) {
      if (this.buffers[stream] !== "") this.read(this.buffers[stream]);
      this.buffers[stream] = "";
    }
    if (!this.recognized) return null;
    for (const name of CHECK_SUITES) {
      if (this.suites[name].state === "pending" || this.suites[name].state === "running") {
        this.suites[name].state = "unknown";
      }
    }
    return this.emit(true, true);
  }

  snapshot(final = false): CheckProgressSnapshot {
    const suites = Object.fromEntries(CHECK_SUITES.map(name => [name, { ...this.suites[name] }])) as Record<CheckSuiteName, CheckSuiteProgress>;
    return { version: 1, final, line: checkProgressLine(suites), suites };
  }

  private emit(final = false, force = false): CheckProgressSnapshot {
    const snapshot = this.snapshot(final);
    const identity = JSON.stringify(snapshot);
    if (force || identity !== this.last) {
      this.last = identity;
      this.update(snapshot);
    }
    return snapshot;
  }

  private read(raw: string): void {
    const line = cleanLine(raw);
    if (line === "") return;

    const testFiles = /\bTest Files\b(.+)$/.exec(line);
    if (testFiles !== null) {
      const tail = testFiles[1] ?? "";
      const passed = safeCount(/\b([0-9]+)\s+passed\b/.exec(tail)?.[1]) ?? 0;
      const failed = safeCount(/\b([0-9]+)\s+failed\b/.exec(tail)?.[1]) ?? 0;
      const total = safeCount(/\(([0-9]+)\)\s*$/.exec(tail)?.[1]) ?? passed + failed;
      if (passed + failed > 0 || total > 0) {
        this.recognized = true;
        this.suites.unit = { state: failed > 0 ? "failed" : "passed", passed, failed, skipped: Math.max(0, total - passed - failed), total };
        this.emit();
      }
      return;
    }

    const labeled = /^\s*\[(flows|app)\]\s*(.*)$/i.exec(line) ?? /^\s*(flows|app)\s*:\s*(.*)$/i.exec(line);
    if (labeled === null) return;
    this.recognized = true;
    const name = labeled[1]!.toLowerCase() as "flows" | "app";
    const body = labeled[2] ?? "";
    const totals = /\b([0-9]+)\s+passed\s*,\s*([0-9]+)\s+failed(?:\s*,\s*([0-9]+)\s+skipped)?\b/i.exec(body);
    if (totals !== null) {
      const passed = safeCount(totals[1]) ?? 0;
      const failed = safeCount(totals[2]) ?? 0;
      const skipped = safeCount(totals[3]) ?? 0;
      this.suites[name] = { state: failed > 0 ? "failed" : "passed", passed, failed, skipped, total: passed + failed + skipped };
      this.emit();
      return;
    }
    const fraction = /\b([0-9]+)\s*\/\s*([0-9]+)\b/.exec(body);
    if (fraction !== null) {
      const completed = safeCount(fraction[1]);
      const total = safeCount(fraction[2]);
      if (completed !== null && total !== null && completed <= total) {
        const current = this.suites[name];
        const passed = Math.max(current.passed, completed);
        if (passed + current.failed + current.skipped <= total) {
          this.suites[name] = { ...current, state: "running", passed, total };
          this.emit();
        }
      }
      return;
    }
    const event = /\b(PASS|FAIL|SKIP)\b/i.exec(body)?.[1]?.toUpperCase();
    if (event === undefined) return;
    const identity = `${name}:${event}:${body}`;
    if (this.events.has(identity)) return;
    this.events.add(identity);
    const current = this.suites[name];
    this.suites[name] = {
      ...current,
      state: event === "FAIL" ? "failed" : current.state === "failed" ? "failed" : "running",
      passed: current.passed + (event === "PASS" ? 1 : 0),
      failed: current.failed + (event === "FAIL" ? 1 : 0),
      skipped: current.skipped + (event === "SKIP" ? 1 : 0),
    };
    this.emit();
  }
}
