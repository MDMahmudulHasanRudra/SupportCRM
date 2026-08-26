/**
 * The queue catalogue (`PROJECT_SPEC.md` §121, and `docs/ARCHITECTURE_AUDIT.md` §6.5).
 *
 * Names are declared centrally so the producer and the consumer can never disagree about a string —
 * a mismatch there produces a job that is enqueued successfully and silently never runs, which is
 * one of the harder failures to notice in production.
 *
 * Only `JOB_CENTER` is wired in Phase 1. The rest are declared, not created: BullMQ makes a queue
 * on first use, so an unused name costs nothing, and having the list in one place keeps the
 * intended topology reviewable now instead of accreting one string at a time.
 */
export const QUEUES = {
  /** Generic Job Center execution — every bulk operation runs through this. */
  JOB_CENTER: 'job-center',

  /** Verified inbound provider events, one job per event, keyed for per-conversation ordering. */
  MESSAGE_INCOMING: 'message-incoming',
  /** The single outbound send path. Rate-limited; nothing else may call a channel adapter. */
  MESSAGE_OUTGOING: 'message-outgoing',
  /** Periodic session-health and delivery reconciliation against the gateway. */
  CHANNEL_MAINTENANCE: 'channel-maintenance',

  // Declared for later phases; see docs/IMPLEMENTATION_PLAN.md.
  AI_REQUEST: 'ai-request',
  KNOWLEDGE_INDEX: 'knowledge-index',
  BROADCAST_SEND: 'broadcast-send',
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Default BullMQ job options.
 *
 * `attempts: 3` with exponential backoff matches `PROJECT_SPEC.md` §58. `removeOnComplete` is
 * bounded rather than `true`: keeping a recent window in Redis makes debugging possible, while the
 * durable record lives in Postgres regardless (§184), so nothing is lost when these age out.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600 },
};
