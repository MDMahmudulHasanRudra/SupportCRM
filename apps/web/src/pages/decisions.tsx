import { useCallback, useEffect, useState } from 'react';
import { ai, aiMemory, decisions, type AITurn, type DecisionLog, type DecisionTrace } from '../api/client';
import { useAuth } from '../auth-context';
import { ConfidenceNote, OutcomeChip, describeOutcome } from './automation/chips';
import {
  Empty,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  Pagination,
  RelativeTime,
  TableWrap,
  errorMessage,
  humanise,
  useToast,
} from '../components/ui';

/**
 * Why the system did what it did.
 *
 * Every inbound customer message produces exactly one decision, and this is where an operator reads
 * it. The list answers "what has been happening"; selecting a row answers "why *that*" — which rule
 * won, which rules also matched and lost, whether the AI ran, what knowledge it was shown, and
 * whether anything reached the customer at all.
 *
 * What is deliberately not here: the customer's message, the generated answer, any prompt, any
 * credential. The decision log explains a decision; the inbox holds the conversation.
 */
export function DecisionsPage() {
  const [items, setItems] = useState<DecisionLog[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [outcome, setOutcome] = useState('');
  const [selected, setSelected] = useState<DecisionTrace | null>(null);
  const [error, setError] = useState<string | null>(null);

  const limit = 25;

  const load = useCallback(async () => {
    try {
      const result = await decisions.list({ outcome: outcome || undefined, limit, offset });
      setItems(result.items);
      setTotal(result.total);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'Decisions could not be loaded.'));
      setItems([]);
    }
  }, [outcome, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(id: string) {
    setError(null);
    try {
      setSelected(await decisions.trace(id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That decision could not be opened.');
    }
  }

  return (
    <>
      <PageHeader
        title="Decisions"
        description="One row per incoming customer message. Team messages and the system's own replies never enter this pipeline at all, which is what stops the system answering itself."
      />

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      <div className="toolbar">
        <Field label="Outcome">
          <select
            value={outcome}
            onChange={(event) => {
              setOutcome(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All</option>
            <option value="RULE_REPLY">Rule replied</option>
            <option value="AI_REPLY">AI replied</option>
            <option value="HUMAN_HANDOFF">Sent to a human</option>
            <option value="HUMAN_HANDLING">Human is handling</option>
            <option value="SUPPRESSED">Held back</option>
            <option value="NO_RESPONSE">No response</option>
            <option value="FAILED">Failed</option>
          </select>
        </Field>
        <div className="spacer" />
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {items === null ? (
        <Loading label="Loading decisions…" />
      ) : items.length === 0 ? (
        <Empty
          title={outcome ? 'Nothing with that outcome' : 'No decisions yet'}
          hint={
            outcome
              ? 'Try a different outcome, or clear the filter.'
              : 'A decision is recorded for every inbound customer message. Nothing has arrived yet, or automation has not been switched on for any conversation.'
          }
        />
      ) : (
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Outcome</th>
                <th>Why</th>
                <th>Took</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((decision) => (
                <tr key={decision.id}>
                  <td className="small">
                    <RelativeTime value={decision.createdAt} />
                  </td>
                  <td>
                    <OutcomeChip outcome={decision.outcome} />
                  </td>
                  <td className="small">{decision.reason ?? '—'}</td>
                  <td className="small">
                    {decision.processingTimeMs === null ? '—' : `${decision.processingTimeMs} ms`}
                  </td>
                  <td>
                    <button type="button" onClick={() => void open(decision.id)}>
                      Why?
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      {items !== null && items.length > 0 && (
        <Pagination offset={offset} limit={limit} total={total} onChange={setOffset} />
      )}

      {selected && <DecisionTracePanel trace={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function DecisionTracePanel({ trace, onClose }: { trace: DecisionTrace; onClose: () => void }) {
  const { decision } = trace;
  const { can } = useAuth();
  const toast = useToast();

  const [turns, setTurns] = useState<AITurn[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const [correction, setCorrection] = useState('');

  const canReview = can('conversations.manage');
  // Only worth asking about an answer the AI actually produced. A rule reply is deterministic —
  // if it is wrong, the rule is wrong, and that is a different screen.
  const aiAnswered = decision.outcome === 'AI_REPLY' || decision.aiProvider !== null;

  async function record(kind: 'CORRECT' | 'WRONG' | 'EDITED' | 'ESCALATE') {
    try {
      await ai.feedback({
        verdict: kind,
        decisionId: decision.id,
        conversationId: decision.conversationId ?? undefined,
        aiMessageId: turns?.[0]?.id,
        correctedText: kind === 'EDITED' ? correction.trim() : undefined,
      });
      setVerdict(kind);
      toast.success(
        kind === 'EDITED'
          ? 'Recorded. Your wording becomes a candidate for review — it does not change anything live.'
          : 'Recorded. Thank you.',
      );
    } catch (failure) {
      toast.error(errorMessage(failure, 'That verdict could not be recorded.'));
    }
  }

  // The AI half of the story, loaded alongside: what the model was told about the past, and what it
  // actually returned. Best-effort — a trace without it is still a complete answer to "why".
  useEffect(() => {
    if (!decision.conversationId) return;
    const conversationId = decision.conversationId;

    void ai
      .turns(conversationId)
      .then((result) => setTurns(result.items.filter((turn) => turn.decisionId === decision.id)))
      .catch(() => setTurns([]));

    void aiMemory
      .conversation(conversationId)
      .then((result) => setSummary(result.summary))
      .catch(() => setSummary(null));
  }, [decision.conversationId, decision.id]);

  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-label="Why the system responded">
      <div className="dialog">
        <div className="dialog-head">
          <h2>Why the system responded</h2>
        </div>
        <div className="dialog-body stack">
          <div>
            <OutcomeChip outcome={decision.outcome} />
            <div className="muted small">
              {decision.outcome ? describeOutcome(decision.outcome) : 'This decision is still running.'}
            </div>
          </div>

          {decision.reason && <div>{decision.reason}</div>}

          <div className="stack">
            <strong>Was anything sent?</strong>
            <div className="small">
              {decision.responseMessageId
                ? 'Yes — one reply, tied to this decision.'
                : 'No. Nothing reached the customer.'}
            </div>
          </div>

          {trace.rule && (
            <div className="stack">
              <strong>Rule that acted</strong>
              <div className="small">
                {trace.rule.name}{' '}
                <span className="muted">
                  ({trace.rule.scopeType.toLowerCase()}, priority {trace.rule.priority}
                  {decision.ruleVersion ? `, v${decision.ruleVersion}` : ''})
                </span>
              </div>
            </div>
          )}

          {trace.candidateRules.length > 1 && (
            <div className="stack">
              <strong>Others that matched</strong>
              <div className="muted small">
                A more specific rule beats a broader one before priority is even looked at.
              </div>
              <ul className="steps">
                {trace.candidateRules
                  .filter((candidate) => !candidate.won)
                  .map((candidate) => (
                    <li key={candidate.id}>
                      {candidate.name}{' '}
                      <span className="muted">
                        ({candidate.scopeType.toLowerCase()}, priority {candidate.priority})
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {trace.aiRun && (
            <div className="stack">
              <strong>AI</strong>
              <div className="small">
                {trace.aiRun.provider} · {trace.aiRun.model} · {trace.aiRun.status.toLowerCase()}
                {trace.aiRun.latencyMs !== null ? ` · ${trace.aiRun.latencyMs} ms` : ''}
              </div>
              <ConfidenceNote
                confidence={decision.confidence}
                calibrated={decision.confidenceCalibrated}
              />
              {trace.aiRun.error && <div className="alert">{trace.aiRun.error}</div>}
            </div>
          )}

          <div className="stack">
            <strong>Knowledge</strong>
            <div className="small">
              {decision.knowledgeUsed
                ? `${decision.knowledgeChunkIds?.length ?? 0} published passage(s) from ${
                    decision.knowledgeArticleIds?.length ?? 0
                  } article(s).`
                : 'None was used.'}
            </div>
            <div className="muted small">
              Only published knowledge is ever retrieved, and only knowledge in scope for this
              conversation.
            </div>
          </div>

          {trace.escalation && (
            <div className="stack">
              <strong>Escalation</strong>
              <div className="small">
                {trace.escalation.reason.toLowerCase().replace(/_/g, ' ')} —{' '}
                {trace.escalation.status.toLowerCase()}
              </div>
            </div>
          )}

          {trace.executions.length > 0 && (
            <div className="stack">
              <strong>What ran</strong>
              <ul className="steps">
                {trace.executions.map((execution) => (
                  <li key={execution.id}>
                    {execution.outcome.toLowerCase().replace(/_/g, ' ')}
                    {execution.detail ? ` — ${execution.detail}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {turns && turns.length > 0 && (
            <div className="stack">
              <strong>What the AI returned</strong>
              {turns.map((turn) => (
                <div key={turn.id} className="card card-pad stack">
                  <div className="row">
                    <span className="small">{humanise(turn.decision)}</span>
                    <span className="muted small">
                      {turn.promptTokens ?? '—'} in / {turn.completionTokens ?? '—'} out tokens
                    </span>
                  </div>
                  {turn.content && <div className="small">{turn.content}</div>}
                  {turn.error && <div className="alert">{turn.error}</div>}
                </div>
              ))}
            </div>
          )}

          {summary && (
            <div className="stack">
              <strong>What it knew about this conversation</strong>
              <div className="small">{summary}</div>
              <div className="muted small">
                A rolling summary, supplied as context. It is never treated as approved knowledge.
              </div>
            </div>
          )}

          {canReview && aiAnswered && (
            <div className="stack">
              <strong>Was this answer right?</strong>
              {verdict ? (
                <div className="muted small">Recorded as {humanise(verdict)}.</div>
              ) : (
                <>
                  <div className="row">
                    <button type="button" onClick={() => void record('CORRECT')}>
                      Correct
                    </button>
                    <button type="button" onClick={() => void record('WRONG')}>
                      Wrong
                    </button>
                    <button type="button" onClick={() => void record('ESCALATE')}>
                      Should have asked a human
                    </button>
                  </div>
                  <div className="row">
                    <input
                      placeholder="What should it have said? (optional)"
                      value={correction}
                      onChange={(event) => setCorrection(event.target.value)}
                    />
                    <button type="button" disabled={!correction.trim()} onClick={() => void record('EDITED')}>
                      Save wording
                    </button>
                  </div>
                  <div className="muted small">
                    A correction here never rewrites published knowledge. It becomes evidence for a
                    proposal somebody reviews.
                  </div>
                </>
              )}
            </div>
          )}

          {decision.error && <div className="alert">{decision.error}</div>}
        </div>
        <div className="dialog-foot">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
