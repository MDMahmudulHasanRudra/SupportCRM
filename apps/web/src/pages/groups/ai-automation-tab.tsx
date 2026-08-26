import { useCallback, useEffect, useState } from 'react';
import { groups, type GroupAiStatus } from '../../api/client';
import { Badge, Card, ErrorState, Loading, errorMessage, humanise } from '../../components/ui';

/**
 * Why AI can or cannot reply in this group.
 *
 * The point of this tab is the *reason*, not the switch. A greyed-out toggle tells an operator that
 * something is off; it does not tell them which of five things it is, or which one to change first.
 * So the chain is laid out layer by layer, every blocking layer is marked, and the most specific
 * one is stated in a sentence at the top.
 *
 * The answer is computed by the backend from the same composition the decision engine gates on, so
 * this cannot report AI as permitted while the engine refuses, or the reverse. Nothing here grants
 * anything — changing the switches is what changes the outcome.
 */
export function AiAutomationTab({ groupId }: { groupId: string }) {
  const [status, setStatus] = useState<GroupAiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      setStatus(await groups.aiStatus(groupId));
    } catch (error) {
      setFailure(errorMessage(error, 'Could not load the AI status.'));
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !status) return <Loading label="Checking AI permissions…" />;
  if (failure) return <ErrorState message={failure} onRetry={() => void load()} />;
  if (!status) return null;

  return (
    <div className="stack">
      <Card>
        <Badge tone={status.canReply ? 'ok' : 'bad'}>
          {status.canReply ? 'AI can reply' : 'AI cannot reply'}
        </Badge>
        <p style={{ marginTop: 10, marginBottom: 4 }}>{status.explanation}</p>
        <p className="muted small">{status.scope}</p>
      </Card>

      <Card title="Permission chain">
        <p className="muted small">
          Every layer can withhold permission, and a single &ldquo;off&rdquo; anywhere is decisive. A
          permissive layer cannot switch a blocked one back on.
        </p>
        <ol className="chain">
          <ChainStep
            label="System"
            state={status.system.aiPaused ? 'BLOCKING' : 'OK'}
            detail={
              status.system.aiPaused
                ? 'AI is paused system-wide by the emergency control.'
                : 'AI is not paused system-wide.'
            }
          />
          <ChainStep
            label="WhatsApp session"
            state={status.session.ready ? 'OK' : 'BLOCKING'}
            detail={
              status.session.ready
                ? 'The account is connected.'
                : `The account is ${humanise(status.session.status).toLowerCase()}, so nothing can be sent.`
            }
          />
          <ChainStep
            label="Automation profile"
            state={status.profile ? (status.profile.aiEnabled ? 'OK' : 'BLOCKING') : 'NOT_APPLICABLE'}
            detail={
              status.profile
                ? `${status.profile.name}: AI ${status.profile.aiEnabled ? 'allowed' : 'withheld'}.`
                : 'No profile is applied to this group, so this layer does not apply.'
            }
          />
          <ChainStep
            label="Monitoring"
            state={status.monitoring.collecting ? 'OK' : 'BLOCKING'}
            detail={
              status.monitoring.collecting
                ? 'Messages from this group are being collected.'
                : 'Messages are not being collected, so there is nothing for AI to answer.'
            }
          />
          <ChainStep
            label="Group"
            state={status.group.aiEnabled ? 'OK' : 'BLOCKING'}
            detail={
              status.group.aiEnabled ? 'This group allows AI replies.' : 'This group has AI switched off.'
            }
          />
          <ChainStep
            label="Conversation"
            state="PER_MESSAGE"
            detail="Checked per conversation as each message arrives. Individual conversations here may still have AI switched off."
          />
        </ol>
      </Card>

      <Card title="Related settings">
        <dl className="detail-list">
          <dt className="muted small">Automation</dt>
          <dd>
            <Badge tone={status.group.automationEnabled ? 'ok' : 'neutral'}>
              {status.group.automationEnabled ? 'Active' : 'Inactive'}
            </Badge>
          </dd>
          <dt className="muted small">Pattern analysis</dt>
          <dd>
            <Badge tone={status.group.patternAnalysisEnabled ? 'ok' : 'neutral'}>
              {status.group.patternAnalysisEnabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </dd>
          <dt className="muted small">Knowledge profile</dt>
          <dd>
            {status.knowledge.profileId ?? <span className="muted">None — this group uses global knowledge.</span>}
          </dd>
        </dl>
        <p className="muted small">
          Message collection and pattern analysis are separate permissions from AI replies. A group
          can keep storing messages and contributing patterns while AI is switched off.
        </p>
      </Card>
    </div>
  );
}

/**
 * One layer of the chain.
 *
 * `NOT_APPLICABLE` and `PER_MESSAGE` are deliberately distinct from `OK`: a layer that does not
 * apply has not granted anything, and showing it as a green tick would suggest a check passed that
 * was never run.
 */
function ChainStep({
  label,
  state,
  detail,
}: {
  label: string;
  state: 'OK' | 'BLOCKING' | 'NOT_APPLICABLE' | 'PER_MESSAGE';
  detail: string;
}) {
  const tone = state === 'OK' ? 'ok' : state === 'BLOCKING' ? 'bad' : 'neutral';
  const word =
    state === 'OK'
      ? 'Allows'
      : state === 'BLOCKING'
        ? 'Blocks'
        : state === 'PER_MESSAGE'
          ? 'Per message'
          : 'Not applicable';

  return (
    <li className={state === 'BLOCKING' ? 'chain-step blocking' : 'chain-step'}>
      <Badge tone={tone}>{word}</Badge>
      <div className="stack-tight">
        <strong>{label}</strong>
        <span className="muted small">{detail}</span>
      </div>
    </li>
  );
}
