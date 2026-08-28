import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ai, type AIConfigurationRow, type AIProviderRow } from '../../api/client';
import { useAuth } from '../../auth-context';
import { IconAlertCircle } from '../../components/icons';
import { ErrorState, Loading, PageHeader, errorMessage, useToast } from '../../components/ui';

const TONES = ['neutral', 'friendly', 'formal', 'concise'];
const LANGUAGES = [
  { value: 'auto', label: "Match the customer's language" },
  { value: 'en', label: 'English' },
  { value: 'bn', label: 'Bangla' },
  { value: 'mixed', label: 'Bangla and English mixed' },
];
const LENGTHS = ['short', 'medium', 'detailed'];
const EMOJI = ['none', 'minimal', 'expressive'];
const TECHNICAL = ['plain', 'balanced', 'technical'];

/**
 * How the AI sounds, and what else it has been told (`PROJECT_SPEC.md` §23, §24).
 *
 * This screen edits the **global** layer. Support profiles and individual groups can override any
 * single field, and instructions from a narrower scope are *added* to these rather than replacing
 * them — so a rule written here holds everywhere unless somebody deliberately contradicts it, and
 * a group note cannot quietly drop a company-wide constraint.
 */
export function AIVoicePage() {
  const { can } = useAuth();
  const toast = useToast();

  const [providers, setProviders] = useState<AIProviderRow[]>([]);
  const [config, setConfig] = useState<AIConfigurationRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    providerId: '',
    model: '',
    temperature: '',
    maxTokens: '',
    tone: '',
    language: '',
    answerLength: '',
    emojiLevel: '',
    technicalLevel: '',
    systemInstructions: '',
  });

  const canManage = can('settings.manage');

  const load = useCallback(async () => {
    try {
      const [providerList, configList] = await Promise.all([ai.providers(), ai.configurations()]);
      setProviders(providerList.items);

      const global = configList.items.find((row) => row.scopeType === 'GLOBAL' && row.jobSlot === 'DECISION') ?? null;
      setConfig(global);
      if (global) {
        setForm({
          providerId: global.providerId ?? '',
          model: global.model ?? '',
          temperature: global.temperature ?? '',
          maxTokens: global.maxTokens === null ? '' : String(global.maxTokens),
          tone: global.tone ?? '',
          language: global.language ?? '',
          answerLength: global.answerLength ?? '',
          emojiLevel: global.emojiLevel ?? '',
          technicalLevel: global.technicalLevel ?? '',
          systemInstructions: global.systemInstructions ?? '',
        });
      }
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'The AI configuration could not be loaded.'));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await ai.saveConfiguration({
        scopeType: 'GLOBAL',
        jobSlot: 'DECISION',
        providerId: form.providerId || undefined,
        model: form.model.trim() || undefined,
        temperature: form.temperature === '' ? undefined : Number(form.temperature),
        maxTokens: form.maxTokens === '' ? undefined : Number(form.maxTokens),
        tone: form.tone || undefined,
        language: form.language || undefined,
        answerLength: form.answerLength || undefined,
        emojiLevel: form.emojiLevel || undefined,
        technicalLevel: form.technicalLevel || undefined,
        systemInstructions: form.systemInstructions.trim() || undefined,
      });
      await load();
      setSaved(true);
      toast.success('Saved. Every group without its own override uses these.');
    } catch (failure) {
      toast.error(errorMessage(failure, 'That could not be saved.'));
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof typeof form, label: string, options: string[]) => (
    <label>
      {label}
      <select
        value={form[key]}
        disabled={!canManage}
        onChange={(event) => setForm({ ...form, [key]: event.target.value })}
      >
        <option value="">Default</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );

  // Held until the saved configuration arrives. Rendering the form first showed empty fields that
  // were then overwritten — losing anything typed in the gap.
  if (!loaded) {
    return (
      <>
        <PageHeader title="Voice & instructions" />
        <Loading label="Loading the current settings…" />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>Voice &amp; instructions</h1>
        <Link to="/ai/providers" className="small">
          ← Providers
        </Link>
      </div>

      <p className="page-sub">
        The global layer. A support profile or a group can override any single setting here, and
        their extra instructions are added to these rather than replacing them.
      </p>

      {error && <ErrorState message={error} onRetry={() => void load()} icon={<IconAlertCircle size={20} />} />}
      {saved && <div className="hint">Saved.</div>}

      <div className="card card-pad stack">
        <strong>Model</strong>
        <div className="row">
          <label>
            Provider
            <select
              value={form.providerId}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, providerId: event.target.value })}
            >
              <option value="">Highest-priority active provider</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model
            <input
              placeholder="provider default"
              value={form.model}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, model: event.target.value })}
            />
          </label>
        </div>
        <div className="row">
          <label>
            Temperature
            <input
              type="number"
              step="0.1"
              min={0}
              max={2}
              placeholder="0.2"
              value={form.temperature}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, temperature: event.target.value })}
            />
          </label>
          <label>
            Max tokens
            <input
              type="number"
              placeholder="provider default"
              value={form.maxTokens}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, maxTokens: event.target.value })}
            />
          </label>
        </div>
        <div className="muted small">
          Choosing a provider here pins it. Leave it on the default and the fallback chain decides,
          which is what keeps answers flowing when one vendor has a bad afternoon.
        </div>
      </div>

      <div className="card card-pad stack">
        <strong>How it should sound</strong>
        <div className="row">
          {field('tone', 'Tone', TONES)}
          <label>
            Language
            <select
              value={form.language}
              disabled={!canManage}
              onChange={(event) => setForm({ ...form, language: event.target.value })}
            >
              <option value="">Default</option>
              {LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          {field('answerLength', 'Length', LENGTHS)}
          {field('emojiLevel', 'Emoji', EMOJI)}
          {field('technicalLevel', 'Technical level', TECHNICAL)}
        </div>
      </div>

      <div className="card card-pad stack">
        <strong>Extra instructions</strong>
        <textarea
          rows={6}
          placeholder="e.g. Always mention that installation visits are scheduled by the local office."
          value={form.systemInstructions}
          disabled={!canManage}
          onChange={(event) => setForm({ ...form, systemInstructions: event.target.value })}
        />
        <div className="hint">
          These are added to the rules the system always applies — answer only from approved
          knowledge, never invent policy or prices, escalate rather than guess, and never carry out
          a billing, account or network change. Nothing typed here can switch those off.
        </div>
      </div>

      {canManage && (
        <div className="row">
          <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {config && <span className="muted small">Editing the existing global configuration.</span>}
        </div>
      )}
    </>
  );
}
