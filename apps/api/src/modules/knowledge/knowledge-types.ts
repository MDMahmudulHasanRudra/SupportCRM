/**
 * Shared knowledge vocabulary.
 *
 * Kept in one file so the lifecycle and the scope rules have a single definition that entities,
 * services, controllers and the retrieval query all agree on.
 */

/** `PROJECT_SPEC.md` §73 and §198. Only PUBLISHED is eligible for production retrieval. */
export enum KnowledgeStatus {
  DRAFT = 'DRAFT',
  REVIEW = 'REVIEW',
  PUBLISHED = 'PUBLISHED',
  ARCHIVED = 'ARCHIVED',
}

/**
 * `PROJECT_SPEC.md` §74 retrieval priority: Group -> Customer -> Product -> Global.
 *
 * The order below is the precedence order, most specific first, and `SCOPE_PRIORITY` turns it into
 * the weights the retrieval query ranks by.
 */
export enum KnowledgeScopeType {
  GROUP = 'GROUP',
  CUSTOMER = 'CUSTOMER',
  PRODUCT = 'PRODUCT',
  GLOBAL = 'GLOBAL',
}

/**
 * Default scope weights.
 *
 * A group-specific answer beats a customer-specific one, which beats a product note, which beats
 * the general documentation — the order the spec gives. Configurable per §74 through a knowledge
 * profile; these are the fallback.
 */
export const SCOPE_PRIORITY: Record<KnowledgeScopeType, number> = {
  [KnowledgeScopeType.GROUP]: 1.0,
  [KnowledgeScopeType.CUSTOMER]: 0.8,
  [KnowledgeScopeType.PRODUCT]: 0.6,
  [KnowledgeScopeType.GLOBAL]: 0.4,
};

/** Where a document is in the pipeline (§72). */
export enum DocumentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  INDEXED = 'INDEXED',
  /**
   * Parsed, chunked and full-text searchable — but with no vectors, because no embedding provider
   * was configured or the provider failed permanently. A distinct state on purpose: the operator
   * needs to know semantic search will not find this document, and silence would be a lie.
   */
  INDEXED_WITHOUT_VECTORS = 'INDEXED_WITHOUT_VECTORS',
  FAILED = 'FAILED',
}

export enum KnowledgeLinkKind {
  LINK = 'LINK',
  YOUTUBE = 'YOUTUBE',
}

export enum CandidateStatus {
  OPEN = 'OPEN',
  CONVERTED = 'CONVERTED',
  DISMISSED = 'DISMISSED',
}

export enum CandidateSource {
  MANUAL = 'MANUAL',
  /** Declared for the phase that adds AI escalation. Nothing writes it in Phase 4. */
  AI_ESCALATION = 'AI_ESCALATION',
  /**
   * Harvested from the messages of a group that opted in to contributing knowledge.
   *
   * Worth distinguishing from MANUAL: a reviewer reading a queue should know that the question came
   * out of a customer conversation rather than from a colleague who chose to write it down, because
   * the two deserve different levels of scepticism.
   */
  GROUP_MESSAGES = 'GROUP_MESSAGES',
}
