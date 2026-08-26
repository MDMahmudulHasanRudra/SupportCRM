import { Badge } from './ui';

/**
 * Why automation is, or is not, going to answer this conversation.
 *
 * A disabled switch tells an operator that something is off. It does not tell them *which* of the
 * four things that can turn it off actually did — and that is the question they are trying to
 * answer when they look. So every layer is shown with its own state, and the effective result is
 * spelled out underneath.
 *
 * Each layer here is a real stored value:
 *  * the global emergency stop (`/settings/feature-flags`)
 *  * the group's own flag (`/groups/:id`)
 *  * the conversation's flag, and its control state (`/conversations/:id`)
 *
 * Nothing is inferred. If a layer cannot be read — a direct chat has no group — it says so rather
 * than defaulting to "on", because a guess here would be a guess about whether a customer gets an
 * automated reply.
 */

export interface AutomationLayers {
  /** Global emergency stop. True means everything is paused. */
  globallyStopped: boolean | null;
  /** The group's flag, or null when this conversation has no group. */
  group: boolean | null;
  /** The conversation's own flag. */
  conversation: boolean;
  /** A human holding the conversation stands automation down regardless of the flags. */
  controlState: string;
  pausedUntil: string | null;
}

/** The effective answer, and the first reason it is what it is. */
export function effectiveAutomation(layers: AutomationLayers): { on: boolean; reason: string } {
  if (layers.globallyStopped) {
    return { on: false, reason: 'An emergency stop is engaged for the whole system.' };
  }
  if (layers.controlState === 'HUMAN_ACTIVE') {
    return { on: false, reason: 'A person has taken this conversation over.' };
  }
  if (layers.controlState === 'PAUSED') {
    return { on: false, reason: 'This conversation is paused.' };
  }
  if (layers.group === false) {
    return { on: false, reason: 'Automation is off for this group.' };
  }
  if (!layers.conversation) {
    return { on: false, reason: 'Automation is off for this conversation.' };
  }
  return { on: true, reason: 'Nothing is standing automation down.' };
}

export function AutomationStack({ layers, label = 'Automation' }: { layers: AutomationLayers; label?: string }) {
  const effective = effectiveAutomation(layers);

  const row = (name: string, state: boolean | null, offLabel = 'Off') => (
    <div className="stack-row">
      <span className="stack-row-name">{name}</span>
      {state === null ? (
        <span className="muted small">Not applicable</span>
      ) : (
        <Badge tone={state ? 'ok' : 'bad'}>{state ? 'On' : offLabel}</Badge>
      )}
    </div>
  );

  return (
    <div className="stack" style={{ gap: 8 }}>
      {row('System', layers.globallyStopped === null ? null : !layers.globallyStopped, 'Stopped')}
      {row('Group', layers.group)}
      {row('Conversation', layers.conversation)}
      <div className="stack-row">
        <span className="stack-row-name">Who may respond</span>
        <Badge tone={layers.controlState === 'HUMAN_ACTIVE' ? 'warn' : layers.controlState === 'PAUSED' ? 'bad' : 'ok'}>
          {layers.controlState.toLowerCase().replace(/_/g, ' ')}
        </Badge>
      </div>

      <div className={effective.on ? 'stack-effective on' : 'stack-effective'}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong className="small">Effective {label.toLowerCase()}</strong>
          <Badge tone={effective.on ? 'ok' : 'bad'}>{effective.on ? 'On' : 'Off'}</Badge>
        </div>
        <div className="muted small" style={{ marginTop: 4 }}>
          {effective.reason}
        </div>
      </div>
    </div>
  );
}
