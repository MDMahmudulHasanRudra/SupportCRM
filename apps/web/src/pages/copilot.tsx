import { useCallback, useEffect, useState } from 'react';
import { copilot, type CopilotAction, type CopilotAnswer, type CopilotTool } from '../api/client';
import { IconAlertCircle, IconBot } from '../components/icons';
import {
  Badge,
  Card,
  ConfirmDialog,
  Empty,
  Field,
  ErrorState,
  Loading,
  PageHeader,
  RelativeTime,
  TableWrap,
  errorMessage,
  humanise,
  useToast,
} from '../components/ui';

/**
 * The admin assistant (`PROJECT_SPEC.md` §89–§91, §137–§138).
 *
 * The screen is built around the one distinction that matters: a **read** just answers, and a
 * **write** stops and asks. A proposed write shows its blast radius in words — "this turns
 * automation off for 412 groups" — and does nothing until somebody presses the button underneath
 * it. There is no setting that turns that confirmation off.
 *
 * The assistant also cannot exceed the person using it: the tool list is filtered by their own
 * permissions, and the server re-checks on confirm.
 */
export function CopilotPage() {
  const toast = useToast();

  const [tools, setTools] = useState<CopilotTool[] | null>(null);
  const [history, setHistory] = useState<CopilotAction[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<CopilotAnswer | null>(null);
  const [confirming, setConfirming] = useState<CopilotAction | null>(null);
  const [configuring, setConfiguring] = useState<CopilotTool | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [toolList, actions] = await Promise.all([copilot.tools(), copilot.history()]);
      setTools(toolList.items);
      setHistory(actions.items);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'The Copilot could not be loaded.'));
      setTools([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function ask() {
    if (!question.trim()) return;
    setAsking(true);
    setAnswer(null);
    try {
      const result = await copilot.ask(question.trim());
      setAnswer(result);
      if (result.action?.kind === 'WRITE') setConfirming(result.action);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That question could not be answered.'));
    } finally {
      setAsking(false);
    }
  }

  /**
   * Runs a tool, optionally with arguments.
   *
   * Tools that declare required parameters cannot be run from a bare button — the backend validates
   * arguments and would refuse. Those open a small form first; the rest run straight away, which is
   * how this screen already behaved.
   */
  async function runTool(tool: CopilotTool, args: Record<string, unknown> = {}) {
    setAsking(true);
    setAnswer(null);
    try {
      const action = await copilot.invoke({ prompt: `Run ${tool.name}`, tool: tool.name, arguments: args });
      setAnswer({ answered: true, message: tool.description, action, suggestions: [] });
      if (action.kind === 'WRITE') setConfirming(action);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, `${tool.name} could not be run.`));
    } finally {
      setAsking(false);
    }
  }

  async function confirm() {
    if (!confirming) return;
    setBusy(true);
    try {
      const done = await copilot.confirm(confirming.id);
      if (done.status === 'FAILED') toast.error(done.error ?? 'That action failed.');
      else toast.success('Done.');
      setConfirming(null);
      setAnswer(null);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That action could not be carried out.'));
    } finally {
      setBusy(false);
    }
  }

  async function reject(action: CopilotAction) {
    try {
      await copilot.reject(action.id);
      setConfirming(null);
      setAnswer(null);
      toast.info('Nothing was changed.');
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That could not be declined.'));
    }
  }

  return (
    <>
      <PageHeader
        title="Copilot"
        description="Ask about what the system is doing. It answers from real data, and anything that would change something stops and asks you first."
      />

      {error && <ErrorState message={error} onRetry={() => void load()} icon={<IconAlertCircle size={20} />} />}

      <Card>
        <div className="row">
          <input
            placeholder="e.g. how many groups have automation on?"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !asking) void ask();
            }}
          />
          <button type="button" className="primary" disabled={asking || !question.trim()} onClick={() => void ask()}>
            {asking ? 'Thinking…' : 'Ask'}
          </button>
        </div>
        <div className="muted small">
          Every question and every answer is recorded, including the reads. Nothing here can send a
          message or delete anything.
        </div>
      </Card>

      {answer && (
        <Card title={answer.answered ? 'Answer' : 'I could not tell'}>
          <p>{answer.message}</p>

          {answer.action?.result && answer.action.kind === 'READ' && (
            <pre className="mono card card-pad" style={{ overflowX: 'auto', margin: 0 }}>
              {prettyResult(answer.action.result)}
            </pre>
          )}

          {answer.suggestions.length > 0 && (
            <div className="stack">
              <strong>Try one of these</strong>
              {answer.suggestions.map((suggestion) => (
                <div key={suggestion.name} className="row">
                  <button
                    type="button"
                    onClick={() => {
                      const tool = tools?.find((entry) => entry.name === suggestion.name);
                      if (tool) void runTool(tool);
                    }}
                  >
                    {suggestion.name}
                  </button>
                  <span className="muted small">{suggestion.description}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tools === null ? (
        <Loading label="Loading tools…" />
      ) : tools.length === 0 ? (
        <Empty
          title="No tools available to you"
          hint="Copilot tools are gated by the same permissions as the rest of the console. Ask an administrator for the ones you need."
          icon={<IconBot size={20} />}
        />
      ) : (
        <Card title="What it can do">
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Type</th>
                  <th>What it does</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tools.map((tool) => (
                  <tr key={tool.name}>
                    <td className="mono">{tool.name}</td>
                    <td>
                      <Badge tone={tool.kind === 'WRITE' ? 'warn' : 'ok'} title={
                        tool.kind === 'WRITE'
                          ? 'Proposes a change and waits for your confirmation.'
                          : 'Runs immediately and only reads.'
                      }>
                        {tool.kind === 'WRITE' ? 'Asks first' : 'Read only'}
                      </Badge>
                    </td>
                    <td className="small">{tool.description}</td>
                    <td>
                      {tool.parameters.length === 0 ? (
                        <button type="button" disabled={asking} onClick={() => void runTool(tool)}>
                          Run
                        </button>
                      ) : (
                        <button type="button" disabled={asking} onClick={() => setConfiguring(tool)}>
                          {tool.parameters.some((parameter) => parameter.required) ? 'Configure…' : 'Run…'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}

      {configuring && (
        <ToolArguments
          tool={configuring}
          busy={asking}
          onCancel={() => setConfiguring(null)}
          onRun={(args) => {
            const tool = configuring;
            setConfiguring(null);
            void runTool(tool, args);
          }}
        />
      )}

      <Card title="Recent activity">
        {history.length === 0 ? (
          <Empty title="Nothing yet" hint="Questions and actions appear here as they happen." />
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Asked</th>
                  <th>Tool</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((action) => (
                  <tr key={action.id}>
                    <td className="small">
                      <RelativeTime value={action.createdAt} />
                    </td>
                    <td className="small">{action.prompt.slice(0, 80)}</td>
                    <td className="mono small">{action.tool ?? '—'}</td>
                    <td>
                      <Badge
                        tone={
                          action.status === 'CONFIRMED' || action.status === 'EXECUTED'
                            ? 'ok'
                            : action.status === 'FAILED'
                              ? 'bad'
                              : action.status === 'PROPOSED'
                                ? 'warn'
                                : 'neutral'
                        }
                      >
                        {humanise(action.status)}
                      </Badge>
                    </td>
                    <td>
                      {action.status === 'PROPOSED' && action.kind === 'WRITE' && (
                        <div className="row">
                          <button type="button" onClick={() => setConfirming(action)}>
                            Review
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {confirming && (
        <ConfirmDialog
          title="This would change something"
          confirmLabel="Do it"
          busy={busy}
          body={
            <div className="stack">
              <div className="alert">{confirming.blastRadius ?? 'This makes a change.'}</div>
              <div className="small">
                <strong>Tool:</strong> <span className="mono">{confirming.tool}</span>
              </div>
              {confirming.arguments && Object.keys(confirming.arguments).length > 0 && (
                <pre className="mono" style={{ margin: 0, overflowX: 'auto' }}>{JSON.stringify(confirming.arguments, null, 2)}</pre>
              )}
              <div className="muted small">
                Nothing has happened yet. Declining leaves everything exactly as it is.
              </div>
            </div>
          }
          onConfirm={() => void confirm()}
          onCancel={() => void reject(confirming)}
        />
      )}
    </>
  );
}

/** Results are stored as JSON strings; show them as something a person can read. */
function prettyResult(result: string): string {
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
}


/**
 * Collects a tool's declared arguments before running it.
 *
 * Built from `tool.parameters` rather than hand-written per tool, so a tool added to the backend
 * registry becomes runnable here without a frontend change — which is the same reason the tool list
 * itself is fetched rather than hard-coded.
 *
 * Running is still only a *proposal* for a WRITE tool: the existing confirmation dialog appears
 * afterwards with the blast radius, and nothing is applied until that is accepted.
 */
function ToolArguments({
  tool,
  busy,
  onCancel,
  onRun,
}: {
  tool: CopilotTool;
  busy: boolean;
  onCancel: () => void;
  onRun: (args: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  const missing = tool.parameters
    .filter((parameter) => parameter.required && !String(values[parameter.name] ?? '').trim())
    .map((parameter) => parameter.name);

  const submit = () => {
    const args: Record<string, unknown> = {};
    for (const parameter of tool.parameters) {
      const raw = String(values[parameter.name] ?? '').trim();
      // An omitted optional argument is left out entirely rather than sent as an empty string —
      // the backend distinguishes "not given" from "given as blank".
      if (!raw) continue;
      if (parameter.type === 'number') args[parameter.name] = Number(raw);
      else if (parameter.type === 'boolean') args[parameter.name] = raw === 'true';
      else args[parameter.name] = raw;
    }
    onRun(args);
  };

  return (
    <ConfirmDialog
      title={`Run ${tool.name}`}
      body={
        <div className="stack">
          <p className="muted small">{tool.description}</p>
          {tool.parameters.map((parameter) => (
            <Field
              key={parameter.name}
              label={`${parameter.name}${parameter.required ? '' : ' (optional)'}`}
              hint={parameter.type}
            >
              {parameter.type === 'boolean' ? (
                <select
                  value={values[parameter.name] ?? ''}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [parameter.name]: event.target.value }))
                  }
                >
                  <option value="">Choose…</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  value={values[parameter.name] ?? ''}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [parameter.name]: event.target.value }))
                  }
                  placeholder={parameter.type}
                />
              )}
            </Field>
          ))}
          {tool.kind === 'WRITE' && (
            <p className="muted small">
              This only proposes the change. You will see how much it affects before anything happens.
            </p>
          )}
        </div>
      }
      confirmLabel={missing.length > 0 ? `Fill in ${missing.join(', ')}` : 'Run'}
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => {
        if (missing.length === 0) submit();
      }}
    />
  );
}
