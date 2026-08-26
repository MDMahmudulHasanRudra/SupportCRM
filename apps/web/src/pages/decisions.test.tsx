import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionLog, DecisionTrace } from '../api/client';
import { AuthProvider } from '../auth-context';
import { DecisionsPage } from './decisions';

/**
 * Two properties of the trace screen are worth holding still.
 *
 * 1. It never claims a reply was sent when none was. "The AI answered" and "the customer received
 *    something" are different facts, and conflating them is how somebody concludes the system is
 *    working when it is silently escalating everything.
 * 2. A confidence number is never shown as a bare figure. It is a provider's self-report, it is not
 *    calibrated against outcomes, and rendering it like a measurement invites tuning against it.
 */

const list = vi.fn();
const trace = vi.fn();

// Partial mock: only the endpoints this file drives are replaced. The rest of the module has to
// come through for real — `auth-context` narrows failures with `error instanceof ApiError`, and a
// mock without that class turns a background `me()` call into an unhandled rejection that vitest
// reports on whichever test happened to be running.
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  get decisions() {
    return {
      list: (...args: unknown[]) => list(...args),
      trace: (...args: unknown[]) => trace(...args),
    };
  },
  // The trace panel also loads the AI turn log and the conversation summary. Both are
  // best-effort in the component, so empty answers here exercise the same paths a conversation
  // with no AI involvement takes.
  get ai() {
    return { turns: () => Promise.resolve({ items: [] }) };
  },
  get aiMemory() {
    return { conversation: () => Promise.resolve({ conversationId: 'conv-1', summary: null, turnCount: 0 }) };
  },
  // The panel reads permissions to decide whether to offer the feedback controls, so the tree
  // needs a real AuthProvider — which needs the session call this mock otherwise removes.
  get auth() {
    return { me: () => Promise.reject(new Error('no session in tests')), login: vi.fn(), logout: vi.fn() };
  },
}));

const decision: DecisionLog = {
  id: 'dec-1',
  messageId: 'msg-1',
  conversationId: 'conv-1',
  groupId: null,
  customerId: null,
  status: 'COMPLETED',
  outcome: 'HUMAN_HANDOFF',
  reasonCode: 'AI_LOW_CONFIDENCE',
  reason: 'The AI was not confident enough to answer.',
  ruleId: null,
  ruleVersion: null,
  candidateRuleIds: null,
  aiProvider: 'openai',
  aiModel: 'gpt-4o-mini',
  confidence: '0.640',
  confidenceCalibrated: false,
  knowledgeUsed: true,
  knowledgeArticleIds: ['art-1'],
  knowledgeChunkIds: ['chunk-1', 'chunk-2'],
  escalationReason: 'AI_LOW_CONFIDENCE',
  humanRequired: true,
  responseMessageId: null,
  processingTimeMs: 812,
  error: null,
  createdAt: new Date('2026-08-24T10:00:00Z').toISOString(),
  completedAt: new Date('2026-08-24T10:00:01Z').toISOString(),
};

const fullTrace: DecisionTrace = {
  decision,
  rule: null,
  candidateRules: [],
  executions: [],
  aiRun: {
    id: 'run-1',
    provider: 'openai',
    model: 'gpt-4o-mini',
    status: 'SUCCEEDED',
    promptTokens: 900,
    completionTokens: 60,
    latencyMs: 700,
    confidence: '0.640',
    error: null,
  },
  escalation: { id: 'esc-1', reason: 'AI_LOW_CONFIDENCE', status: 'OPEN', createdAt: decision.createdAt },
};

/** The page as the app mounts it. `useAuth` throws outside the provider, and rightly so. */
const renderPage = () =>
  render(
    <AuthProvider>
      <DecisionsPage />
    </AuthProvider>,
  );

describe('Decision trace', () => {
  it('says plainly that nothing reached the customer', async () => {
    list.mockResolvedValue({ items: [decision], total: 1 });
    trace.mockResolvedValue(fullTrace);

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Why?' }));

    await waitFor(() => expect(screen.getByText(/Nothing reached the customer/)).toBeInTheDocument());
  });

  it('never presents the confidence number as a measurement', async () => {
    list.mockResolvedValue({ items: [decision], total: 1 });
    trace.mockResolvedValue(fullTrace);

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Why?' }));

    const caveat = await screen.findByText(/self-reported, uncalibrated/);
    expect(caveat).toBeInTheDocument();
  });
});
