import { Injectable } from '@nestjs/common';

/**
 * In-process counters and duration summaries (Phase 2 brief §18).
 *
 * Deliberately not Prometheus, not StatsD, no new dependency. What §18 asks for is that the
 * important events are *counted and observable*; a scrape endpoint or a metrics backend is a
 * deployment decision for Phase 11 hardening. This gives every call site a stable API to record
 * against now, so wiring a real exporter later is one adapter rather than a hunt through the
 * codebase for the things that should have been instrumented.
 *
 * Values are per-process. With several API and worker containers, each reports its own — which is
 * accurate rather than misleading, and exactly what a scraper would collect anyway.
 *
 * Label cardinality is bounded on purpose: labels come only from closed sets in our own code
 * (a rejection reason, an event type), never from user input. Unbounded labels are how an
 * in-memory metrics map becomes a memory leak.
 */
export interface MetricSnapshot {
  counters: Record<string, number>;
  durations: Record<string, { count: number; totalMs: number; avgMs: number; maxMs: number }>;
}

const MAX_SERIES = 500;

@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, { count: number; totalMs: number; maxMs: number }>();

  increment(name: string, labels?: Record<string, string>, by = 1): void {
    const key = this.seriesKey(name, labels);
    if (key === null) return;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  /** Records a duration. Use with `Date.now()` deltas around a queue hop or a gateway call. */
  observeDuration(name: string, ms: number, labels?: Record<string, string>): void {
    const key = this.seriesKey(name, labels);
    if (key === null || !Number.isFinite(ms) || ms < 0) return;

    const existing = this.durations.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
    existing.count += 1;
    existing.totalMs += ms;
    existing.maxMs = Math.max(existing.maxMs, ms);
    this.durations.set(key, existing);
  }

  /** Times an async operation, recording the duration whether it succeeds or throws. */
  async time<T>(name: string, fn: () => Promise<T>, labels?: Record<string, string>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.observeDuration(name, Date.now() - started, labels);
    }
  }

  snapshot(): MetricSnapshot {
    const durations: MetricSnapshot['durations'] = {};
    for (const [key, value] of this.durations) {
      durations[key] = {
        count: value.count,
        totalMs: value.totalMs,
        avgMs: value.count === 0 ? 0 : Math.round((value.totalMs / value.count) * 100) / 100,
        maxMs: value.maxMs,
      };
    }
    return { counters: Object.fromEntries(this.counters), durations };
  }

  /** Test-only. Never called in production — counters are monotonic by design. */
  reset(): void {
    this.counters.clear();
    this.durations.clear();
  }

  /**
   * Builds `name{label="value"}`. Returns null once the series cap is hit, so an accidental
   * unbounded label can degrade metrics but can never exhaust memory.
   */
  private seriesKey(name: string, labels?: Record<string, string>): string | null {
    const key = labels
      ? `${name}{${Object.entries(labels)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}="${String(v).slice(0, 64)}"`)
          .join(',')}}`
      : name;

    if (!this.counters.has(key) && !this.durations.has(key)) {
      if (this.counters.size + this.durations.size >= MAX_SERIES) return null;
    }
    return key;
  }
}
