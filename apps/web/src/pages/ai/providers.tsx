import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ai, type AIConfigurationRow, type AIProviderKind, type AIProviderRow } from '../../api/client';
import { useAuth } from '../../auth-context';
import { errorMessage, useToast } from '../../components/ui';

const KINDS: Array<{ value: AIProviderKind; label: string; hint: string }> = [
  { value: 'openai', label: 'OpenAI', hint: 'api.openai.com' },
  { value: 'anthropic', label: 'Anthropic', hint: 'api.anthropic.com' },
  { value: 'gemini', label: 'Google Gemini', hint: 'generativelanguage.googleapis.com' },
  { value: 'openrouter', label: 'OpenRouter', hint: 'openrouter.ai' },
  { value: 'compatible', label: 'Other OpenAI-compatible', hint: 'Give the base URL — self-hosted, vLLM, Groq…' },
];

/**
 * Where an administrator points the system at a model (`PROJECT_SPEC.md` §21–§24).
 *
 * Two things this screen is careful about:
 *
 * **A key goes in and never comes out.** The API returns whether a credential is stored, never the
 * credential, so this page can show "set" and offer to replace it — and has nothing to leak.
 *
 * **Adding a provider does not switch it on.** A new provider arrives inactive. Turning it on is a
 * separate, deliberate click, because the moment it is active it can answer a real customer.
 */
export function AIProvidersPage() {
  const { can } = useAuth();
  const toast = useToast();

  const [providers, setProviders] = useState<AIProviderRow[] | null>(null);
  const [configs, setConfigs] = useState<AIConfigurationRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; detail: string }>>({});

  const [draft, setDraft] = useState({
    name: '',
    kind: 'openai' as AIProviderKind,
    baseUrl: '',
    apiKey: '',
    defaultModel: '',
    priority: 100,
  });

  const canManage = can('settings.manage');

  const load = useCallback(async () => {
    try {
      const [providerList, configList] = await Promise.all([ai.providers(), ai.configurations()]);
      setProviders(providerList.items);
      setConfigs(configList.items);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load AI providers.');
      setProviders([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setError(null);
    try {
      await ai.createProvider({
        name: draft.name.trim(),
        kind: draft.kind,
        baseUrl: draft.baseUrl.trim() || undefined,
        apiKey: draft.apiKey.trim() || undefined,
        defaultModel: draft.defaultModel.trim() || undefined,
        priority: draft.priority,
      });
      toast.success(`${draft.name.trim()} added, switched off. Turn it on when you are ready for it to answer.`);
      setDraft({ name: '', kind: 'openai', baseUrl: '', apiKey: '', defaultModel: '', priority: 100 });
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That provider could not be added.'));
    }
  }

  async function toggle(provider: AIProviderRow, isActive: boolean) {
    setError(null);
    try {
      await ai.updateProvider(provider.id, { isActive });
      toast.success(
        isActive
          ? `${provider.name} is active. It can now answer customers.`
          : `${provider.name} switched off.`,
      );
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That change was refused.'));
    }
  }

  async function test(provider: AIProviderRow) {
    setTesting(provider.id);
    try {
      const outcome = await ai.testProvider(provider.id);
      setResults({ ...results, [provider.id]: outcome });
      await load();
    } catch (failure) {
      setResults({
        ...results,
        [provider.id]: { ok: false, detail: failure instanceof Error ? failure.message : 'The test failed.' },
      });
    } finally {
      setTesting(null);
    }
  }

  async function remove(provider: AIProviderRow) {
    setError(null);
    try {
      await ai.deleteProvider(provider.id);
      toast.success(`${provider.name} removed.`);
      await load();
    } catch (failure) {
      toast.error(errorMessage(failure, 'That provider could not be removed.'));
    }
  }

  const globalConfig = configs.find((config) => config.scopeType === 'GLOBAL' && config.jobSlot === 'DECISION');

  return (
    <>
      <div className="page-head">
        <h1>AI providers</h1>
        <div className="row">
          <Link to="/ai/voice" className="small">
            Voice &amp; instructions →
          </Link>
          <Link to="/automation/profiles" className="small">
            Confidence thresholds →
          </Link>
        </div>
      </div>

      <p className="page-sub">
        Providers are tried in priority order. One that fails repeatedly is rested rather than
        hammered, and the next takes over. If every provider is down, the system asks a person — it
        never guesses an answer.
      </p>

      {error && <div className="alert">{error}</div>}

      {providers === null ? (
        <div className="progress">
          <span className="spinner" aria-hidden="true" />
          <span className="muted">Loading…</span>
        </div>
      ) : providers.length === 0 ? (
        <div className="empty">
          No AI provider is configured. Rules still run; anything a rule cannot answer goes to a
          person.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th>Key</th>
                <th>Priority</th>
                <th>Active</th>
                <th>Last check</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => (
                <tr key={provider.id}>
                  <td>
                    {provider.name}
                    <div className="muted small">{provider.kind}</div>
                  </td>
                  <td className="small">{provider.defaultModel ?? '—'}</td>
                  <td className="small">
                    {provider.hasApiKey ? (
                      <span className="badge" title="A credential is stored. It is never shown.">
                        <span className="dot ok" aria-hidden="true" />
                        Set
                      </span>
                    ) : (
                      <span className="muted">none</span>
                    )}
                  </td>
                  <td className="small">{provider.priority}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={provider.isActive}
                      disabled={!canManage}
                      aria-label={`Activate ${provider.name}`}
                      onChange={(event) => void toggle(provider, event.target.checked)}
                    />
                  </td>
                  <td className="small">
                    {results[provider.id] ? (
                      <span className={results[provider.id].ok ? 'muted' : ''}>
                        {results[provider.id].detail}
                      </span>
                    ) : provider.lastError ? (
                      <span title={provider.lastError}>failed</span>
                    ) : provider.lastCheckedAt ? (
                      new Date(provider.lastCheckedAt).toLocaleString()
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <div className="row">
                      {canManage && (
                        <button type="button" disabled={testing === provider.id} onClick={() => void test(provider)}>
                          {testing === provider.id ? 'Testing…' : 'Test'}
                        </button>
                      )}
                      {canManage && !provider.isActive && (
                        <button type="button" onClick={() => void remove(provider)}>
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canManage && (
        <div className="card card-pad stack">
          <strong>Add a provider</strong>
          <div className="row">
            <label>
              Name
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label>
              Kind
              <select
                value={draft.kind}
                onChange={(event) => setDraft({ ...draft, kind: event.target.value as AIProviderKind })}
              >
                {KINDS.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted small">{KINDS.find((k) => k.value === draft.kind)?.hint}</span>
          </div>

          <div className="row">
            <label>
              Model
              <input
                placeholder="e.g. gpt-4o-mini"
                value={draft.defaultModel}
                onChange={(event) => setDraft({ ...draft, defaultModel: event.target.value })}
              />
            </label>
            <label>
              Priority
              <input
                type="number"
                value={draft.priority}
                onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })}
              />
            </label>
          </div>

          {draft.kind === 'compatible' && (
            <label>
              Base URL
              <input
                placeholder="https://your-endpoint/v1"
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </label>
          )}

          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
          </label>
          <div className="muted small">
            Stored encrypted and never shown again — not here, not in a log, not in an error. To
            change it later, type a new one.
          </div>

          <button type="button" className="primary" disabled={!draft.name.trim()} onClick={() => void create()}>
            Add provider
          </button>
          <div className="hint">
            A new provider starts switched off. Turning it on is what lets it answer customers.
          </div>
        </div>
      )}

      <div className="card card-pad stack">
        <strong>Currently answering</strong>
        {globalConfig ? (
          <div className="small">
            Global default: {globalConfig.model ?? 'the provider default'}
            {globalConfig.providerId ? '' : ' (first active provider)'}
          </div>
        ) : (
          <div className="muted small">
            No global override — the highest-priority active provider and its default model answer.
          </div>
        )}
        <div className="muted small">
          {configs.length} configuration{configs.length === 1 ? '' : 's'} across all scopes.
        </div>
      </div>
    </>
  );
}
