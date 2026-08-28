import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { candidates, type AutomationCandidate } from '../../api/client';
import { useAuth } from '../../auth-context';
import { IconAlertCircle, IconInbox } from '../../components/icons';
import {
  Badge,
  Card,
  ConfirmDialog,
  Empty,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  RelativeTime,
  errorMessage,
  humanise,
  useToast,
} from '../../components/ui';

/**
 * The review queue for proposed automation (`PROJECT_SPEC.md` §85–§88, §135, §136).
 *
 * A candidate is a suggestion with evidence attached, and this screen exists so the evidence is
 * read before anything ships. Two properties it makes visible rather than assuming:
 *
 * **The reply is not written yet.** The system knows a question repeats; it does not know the
 * answer. Publishing requires typing one, which is the whole point of the review.
 *
 * **Publishing does not go live.** It creates a Draft rule that still needs approving — two
 * people between "we noticed a pattern" and "we say this to customers".
 */
export function CandidatesPage() {
  const { can } = useAuth();
  const toast = useToast();

  const [items, setItems] = useState<AutomationCandidate[] | null>(null);
  const [status, setStatus] = useState('PENDING');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [open, setOpen] = useState<AutomationCandidate | null>(null);
  const [evidence, setEvidence] = useState<Array<{ id: string; body: string | null; sentAt: string }>>([]);
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState<AutomationCandidate | null>(null);

  const canReview = can('automation.approve');
  const canDetect = can('automation.create');

  const load = useCallback(async () => {
    try {
      const result = await candidates.list(status || undefined);
      setItems(result.items);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'The review queue could not be loaded.'));
      setItems([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function detect() {
    setBusy(true);
    try {
      const result = await candidates.detect({ sinceDays: 30 });
      toast.success(
        result.created === 0 && result.updated === 0
          ? 'Nothing new — no question repeated often enough to propose a rule.'
          : `${result.created} new proposal${result.created === 1 ? '' : 's'}, ${result.updated} updated.`,
      );
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'The scan could not be run.'));
    } finally {
      setBusy(false);
    }
  }

  async function openCandidate(candidate: AutomationCandidate) {
    setOpen(candidate);
    setReply(firstReply(candidate));
    setNote('');
    setEvidence([]);
    try {
      const result = await candidates.evidence(candidate.id);
      setEvidence(result.items);
    } catch {
      // Evidence is helpful, not essential — a reviewer can still act without it.
      setEvidence([]);
    }
  }

  async function publish() {
    if (!open) return;
    if (!reply.trim()) {
      toast.error('Write the reply this rule should send before publishing it.');
      return;
    }

    setBusy(true);
    try {
      await candidates.publish(open.id, {
        note: note || undefined,
        conditions: open.proposedConditions ?? undefined,
        actions: [{ type: 'SEND_MESSAGE', value: reply.trim() }],
      });
      toast.success('Published as a Draft rule. It still needs activating before it answers anyone.');
      setOpen(null);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That candidate could not be published.'));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!rejecting) return;
    setBusy(true);
    try {
      await candidates.reject(rejecting.id, note || undefined);
      toast.info('Declined. It will not be proposed again.');
      setRejecting(null);
      setOpen(null);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That candidate could not be declined.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Proposed automation"
        description="Questions customers keep asking that a person had to answer. Each one is a suggestion with its evidence attached — nothing here can reach a customer until you publish it and somebody approves the rule."
        actions={
          <>
            <Link to="/automation" className="small">
              ← Rules
            </Link>
            {canDetect && (
              <button type="button" className="primary" disabled={busy} onClick={() => void detect()}>
                {busy ? 'Scanning…' : 'Scan for patterns'}
              </button>
            )}
          </>
        }
      />

      {error && <ErrorState message={error} onRetry={() => void load()} icon={<IconAlertCircle size={20} />} />}

      <div className="toolbar">
        <Field label="Status">
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="PENDING">Awaiting review</option>
            <option value="PUBLISHED">Published</option>
            <option value="REJECTED">Declined</option>
            <option value="">All</option>
          </select>
        </Field>
      </div>

      {items === null ? (
        <Loading label="Loading proposals…" />
      ) : items.length === 0 ? (
        <Empty
          title={status === 'PENDING' ? 'Nothing waiting for review' : 'Nothing here'}
          hint={
            status === 'PENDING'
              ? 'Run a scan to look for questions that came up repeatedly and needed a person each time.'
              : 'Try a different status.'
          }
          action={
            canDetect && status === 'PENDING' ? (
              <button type="button" className="primary" onClick={() => void detect()}>
                Scan for patterns
              </button>
            ) : null
          }
          icon={<IconInbox size={20} />}
        />
      ) : (
        <div className="stack">
          {items.map((candidate) => (
            <div key={candidate.id} className="card card-pad stack">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{candidate.title}</strong>
                <div className="row">
                  <Badge tone={candidate.occurrences >= 10 ? 'warn' : 'neutral'}>
                    Asked {candidate.occurrences}×
                  </Badge>
                  <Badge
                    tone={
                      candidate.status === 'PUBLISHED' ? 'ok' : candidate.status === 'REJECTED' ? 'bad' : 'busy'
                    }
                  >
                    {humanise(candidate.status)}
                  </Badge>
                </div>
              </div>

              {candidate.rationale && <p className="small">{candidate.rationale}</p>}

              <div className="row">
                <span className="muted small">
                  Found <RelativeTime value={candidate.createdAt} /> · source {humanise(candidate.source)}
                </span>
                <div className="spacer" />
                {canReview && candidate.status === 'PENDING' && (
                  <>
                    <button type="button" className="primary" onClick={() => void openCandidate(candidate)}>
                      Review
                    </button>
                    <button type="button" onClick={() => setRejecting(candidate)}>
                      Decline
                    </button>
                  </>
                )}
                {candidate.publishedRuleId && (
                  <Link to={`/automation/rules/${candidate.publishedRuleId}`} className="small">
                    Open the rule →
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="backdrop" role="dialog" aria-modal="true" aria-label="Review proposal">
          <div className="dialog" style={{ width: 'min(620px, 100%)' }}>
            <div className="dialog-head">
              <h2>Review this proposal</h2>
            </div>
            <div className="dialog-body stack">
              <div className="small">{open.rationale}</div>

              <Card title="What customers actually wrote">
                {evidence.length === 0 ? (
                  <p className="muted small">No sample messages were recorded for this proposal.</p>
                ) : (
                  <ul className="steps">
                    {evidence.slice(0, 5).map((message) => (
                      <li key={message.id}>{(message.body ?? '').slice(0, 200)}</li>
                    ))}
                  </ul>
                )}
              </Card>

              <Field
                label="The reply this rule should send"
                hint="Written by you, not by the system. It knows the question repeats; it does not know your answer."
              >
                <textarea rows={4} value={reply} onChange={(event) => setReply(event.target.value)} />
              </Field>

              <Field label="Note (optional)">
                <input value={note} onChange={(event) => setNote(event.target.value)} />
              </Field>

              <div className="hint">
                Publishing creates a <strong>Draft</strong> rule. It answers nobody until it is
                activated on the rules screen.
              </div>
            </div>
            <div className="dialog-foot">
              <button type="button" onClick={() => setOpen(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => void publish()} disabled={busy || !reply.trim()}>
                {busy ? 'Publishing…' : 'Publish as draft'}
              </button>
            </div>
          </div>
        </div>
      )}

      {rejecting && (
        <ConfirmDialog
          title="Decline this proposal?"
          confirmLabel="Decline"
          tone="normal"
          busy={busy}
          body={
            <div className="stack">
              <p>
                <strong>{rejecting.title}</strong>
              </p>
              <p className="muted small">
                It will not be proposed again, even if the question keeps coming up. A note helps
                whoever wonders why later.
              </p>
              <Field label="Reason (optional)">
                <input value={note} onChange={(event) => setNote(event.target.value)} />
              </Field>
            </div>
          }
          onConfirm={() => void reject()}
          onCancel={() => setRejecting(null)}
        />
      )}
    </>
  );
}

/** The proposed reply, if the detector managed to suggest one. Usually empty by design. */
function firstReply(candidate: AutomationCandidate): string {
  const action = candidate.proposedActions?.find((entry) => entry.type === 'SEND_MESSAGE');
  return action?.value ?? '';
}
