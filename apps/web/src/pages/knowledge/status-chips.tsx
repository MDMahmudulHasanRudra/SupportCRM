import type { DocumentStatus, KnowledgeStatus } from '../../api/client';

/**
 * Status at a glance, reusing the badge the rest of the console already uses.
 *
 * The distinction worth being loud about is `INDEXED_WITHOUT_VECTORS`: the document is searchable
 * by words but not by meaning, and an operator who does not know that will wonder why a sensible
 * question never finds it.
 */

export function KnowledgeStatusChip({ status }: { status: KnowledgeStatus }) {
  const tone =
    status === 'PUBLISHED' ? 'ok' : status === 'REVIEW' ? 'warn' : status === 'ARCHIVED' ? 'bad' : '';

  return (
    <span className="badge" title={describeKnowledgeStatus(status)}>
      <span className={`dot ${tone}`} aria-hidden="true" />
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

export function describeKnowledgeStatus(status: KnowledgeStatus): string {
  switch (status) {
    case 'DRAFT':
      return 'Being written. Never used to answer a customer.';
    case 'REVIEW':
      return 'Waiting for approval. Never used to answer a customer.';
    case 'PUBLISHED':
      return 'Live. This is the only state customer-facing answers can draw on.';
    case 'ARCHIVED':
      return 'Retired. Kept for history and excluded from every search.';
  }
}

export function DocumentStatusChip({ status }: { status: DocumentStatus }) {
  const tone =
    status === 'INDEXED'
      ? 'ok'
      : status === 'FAILED'
        ? 'bad'
        : status === 'INDEXED_WITHOUT_VECTORS'
          ? 'warn'
          : 'busy';

  const label =
    status === 'INDEXED_WITHOUT_VECTORS'
      ? 'Text only'
      : status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');

  return (
    <span className="badge" title={describeDocumentStatus(status)}>
      <span className={`dot ${tone}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function describeDocumentStatus(status: DocumentStatus): string {
  switch (status) {
    case 'PENDING':
      return 'Queued for indexing.';
    case 'PROCESSING':
      return 'Being parsed and indexed now.';
    case 'INDEXED':
      return 'Fully indexed and searchable.';
    case 'INDEXED_WITHOUT_VECTORS':
      return 'Searchable by keyword, but not by meaning — no embeddings were produced.';
    case 'FAILED':
      return 'Indexing failed. See the reason next to the status.';
  }
}
