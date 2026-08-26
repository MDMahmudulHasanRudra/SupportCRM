import type { AutomationStatusValue, DecisionOutcome } from '../../api/client';

/**
 * The small labels the automation and decision screens share.
 *
 * Every one of them carries a sentence in its tooltip. An operator looking at `SUPPRESSED` needs to
 * know that a reply was deliberately withheld, not that something broke — and the shortest place to
 * say so is where they are already looking.
 */

export function RuleStatusChip({ status }: { status: AutomationStatusValue }) {
  const tone =
    status === 'ACTIVE' ? 'ok' : status === 'REVIEW' ? 'warn' : status === 'ARCHIVED' ? 'bad' : '';

  return (
    <span className="badge" title={describeRuleStatus(status)}>
      <span className={`dot ${tone}`} aria-hidden="true" />
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

export function describeRuleStatus(status: AutomationStatusValue): string {
  switch (status) {
    case 'DRAFT':
      return 'Being written. Never runs against a customer message.';
    case 'REVIEW':
      return 'Waiting for approval. Never runs against a customer message.';
    case 'ACTIVE':
      return 'Live. This is the only state in which a rule can answer a customer.';
    case 'PAUSED':
      return 'Temporarily off. Kept as it is, so it can be switched back on unchanged.';
    case 'ARCHIVED':
      return 'Retired. Kept for history and never evaluated.';
  }
}

export function OutcomeChip({ outcome }: { outcome: DecisionOutcome | null }) {
  if (!outcome) {
    return (
      <span className="badge" title="The decision has not finished yet.">
        <span className="dot busy" aria-hidden="true" />
        In progress
      </span>
    );
  }

  const tone =
    outcome === 'RULE_REPLY' || outcome === 'AI_REPLY'
      ? 'ok'
      : outcome === 'FAILED'
        ? 'bad'
        : outcome === 'HUMAN_HANDOFF'
          ? 'warn'
          : '';

  return (
    <span className="badge" title={describeOutcome(outcome)}>
      <span className={`dot ${tone}`} aria-hidden="true" />
      {outcomeLabel(outcome)}
    </span>
  );
}

export function outcomeLabel(outcome: DecisionOutcome): string {
  switch (outcome) {
    case 'RULE_REPLY':
      return 'Rule replied';
    case 'AI_REPLY':
      return 'AI replied';
    case 'HUMAN_HANDOFF':
      return 'Sent to a human';
    case 'HUMAN_HANDLING':
      return 'Human is handling';
    case 'NO_RESPONSE':
      return 'No response';
    case 'SUPPRESSED':
      return 'Held back';
    case 'IGNORE':
      return 'Ignored';
    case 'FAILED':
      return 'Failed';
  }
}

export function describeOutcome(outcome: DecisionOutcome): string {
  switch (outcome) {
    case 'RULE_REPLY':
      return 'A rule matched and its answer was sent.';
    case 'AI_REPLY':
      return 'The knowledge-grounded AI answered, and the answer cleared the confidence policy.';
    case 'HUMAN_HANDOFF':
      return 'Nothing was sent to the customer. The conversation is waiting for a person.';
    case 'HUMAN_HANDLING':
      return 'A person has taken this conversation over, so automation stayed silent.';
    case 'NO_RESPONSE':
      return 'Nothing matched and nothing was sent. This is a normal outcome, not a failure.';
    case 'SUPPRESSED':
      return 'A reply was withheld on purpose — a reply budget, a repeat, or a loop guard.';
    case 'IGNORE':
      return 'A rule explicitly said to do nothing with this message.';
    case 'FAILED':
      return 'The decision could not be completed. A person was notified rather than the customer being ignored.';
  }
}

/**
 * How a confidence number is allowed to be shown.
 *
 * Never as a bare percentage. The value is a language model's self-report, it is not calibrated
 * against anything, and presenting it like a measurement invites somebody to tune a threshold
 * against a number that does not mean what it looks like.
 */
export function ConfidenceNote({
  confidence,
  calibrated,
}: {
  confidence: string | number | null;
  calibrated: boolean;
}) {
  if (confidence === null || confidence === undefined || confidence === '') {
    return <span className="muted small">The provider gave no confidence estimate.</span>;
  }

  const value = Number(confidence);

  return (
    <span
      className="small"
      title={
        calibrated
          ? 'A measured probability.'
          : 'Self-reported by the AI provider. It is not calibrated against real outcomes, so it is evidence, not proof.'
      }
    >
      {value.toFixed(2)}{' '}
      <span className="muted">{calibrated ? '(measured)' : '(self-reported, uncalibrated)'}</span>
    </span>
  );
}
