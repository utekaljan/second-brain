/**
 * Shared terminal progress writer used by long-running ingest and compiler flows.
 *
 * Progress goes to stderr so JSON summaries on stdout stay machine-readable.
 */
export type ProgressWriter = ((message: string) => void) | undefined;

/**
 * Small throttled reporter for terminal-friendly progress updates.
 *
 * The goal is not a perfect progress bar. The goal is to show enough phase and
 * percentage movement that a long-running command no longer looks frozen.
 */
export class ThrottledProgressReporter {
  private readonly lastPercentByKey = new Map<string, number>();
  private readonly lastTimestampByKey = new Map<string, number>();

  constructor(
    private readonly write: ProgressWriter = (message) => console.error(message),
    private readonly percentStep: number = 5,
    private readonly heartbeatMs: number = 15_000
  ) {}

  phase(scope: string, message: string): void {
    this.write?.(`[${scope}] ${message}`);
  }

  item(scope: string, key: string, current: number, total: number, detail?: string): void {
    if (!this.write) {
      return;
    }

    const safeTotal = total <= 0 ? 1 : total;
    const percent = Math.max(0, Math.min(100, Math.floor((current / safeTotal) * 100)));
    const now = Date.now();
    const lastPercent = this.lastPercentByKey.get(key) ?? -1;
    const lastTimestamp = this.lastTimestampByKey.get(key) ?? 0;

    const shouldEmit =
      current <= 1 ||
      current >= total ||
      percent >= lastPercent + this.percentStep ||
      now - lastTimestamp >= this.heartbeatMs;

    if (!shouldEmit) {
      return;
    }

    this.lastPercentByKey.set(key, percent);
    this.lastTimestampByKey.set(key, now);

    const suffix = detail ? ` ${detail}` : "";
    this.write(`[${scope}] ${current}/${total} (${percent}%)${suffix}`);
  }
}
