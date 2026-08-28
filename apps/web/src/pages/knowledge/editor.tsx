import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  knowledge,
  type KnowledgeArticle,
  type KnowledgeCategory,
  type KnowledgeStatus,
  type KnowledgeVersion,
} from '../../api/client';
import { useAuth } from '../../auth-context';
import { IconAlertCircle } from '../../components/icons';
import { RelativeTime } from '../../components/status-badge';
import { ErrorState, Loading } from '../../components/ui';
import { KnowledgeStatusChip, describeKnowledgeStatus } from './status-chips';

/**
 * The article editor.
 *
 * The lifecycle controls are the important part of this screen, so they are explicit about
 * consequence: publishing is the moment content becomes usable in customer-facing answers, and it
 * confirms. Editing a published article sends it back to draft, and the editor says so before the
 * writer discovers it afterwards.
 */
export function KnowledgeEditorPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();

  const [article, setArticle] = useState<KnowledgeArticle | null>(null);
  const [categories, setCategories] = useState<KnowledgeCategory[]>([]);
  const [versions, setVersions] = useState<KnowledgeVersion[]>([]);
  const [diff, setDiff] = useState<Array<{ type: 'same' | 'added' | 'removed'; text: string }> | null>(null);

  const [draft, setDraft] = useState({ title: '', summary: '', body: '' });
  const [linkUrl, setLinkUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canWrite = can('knowledge.create');
  const canApprove = can('knowledge.approve');

  const load = useCallback(async () => {
    try {
      const [loaded, categoryList, versionList] = await Promise.all([
        knowledge.getArticle(id),
        knowledge.categories(),
        knowledge.versions(id),
      ]);
      setArticle(loaded);
      setCategories(categoryList.items);
      setVersions(versionList.items);
      setDraft({ title: loaded.title, summary: loaded.summary ?? '', body: loaded.body ?? '' });
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That article could not be loaded.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const updated = await knowledge.updateArticle(id, {
        title: draft.title,
        summary: draft.summary || undefined,
        body: draft.body,
      });
      setNotice(
        updated.status === 'DRAFT' && article?.status === 'PUBLISHED'
          ? 'Saved. Because the content changed, this article went back to draft and is no longer live.'
          : 'Saved.',
      );
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Those changes could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: KnowledgeStatus) {
    if (status === 'PUBLISHED' && !window.confirm('Publishing makes this article usable in customer-facing answers. Continue?')) {
      return;
    }
    if (status === 'ARCHIVED' && !window.confirm('Archiving removes this article from every search. Continue?')) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await knowledge.setStatus(id, status);
      setNotice(`Status changed to ${status.toLowerCase()}.`);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That status change was refused.');
    } finally {
      setBusy(false);
    }
  }

  async function rollback(version: number) {
    if (!window.confirm(`Restore v${version}? This creates a new version and returns the article to draft.`)) return;

    setBusy(true);
    try {
      await knowledge.rollback(id, version);
      setNotice(`Restored v${version} as a new draft version.`);
      setDiff(null);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The rollback failed.');
    } finally {
      setBusy(false);
    }
  }

  async function showDiff(version: number) {
    if (!article) return;
    try {
      const result = await knowledge.diff(id, version, article.currentVersion);
      setDiff(result.body);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Those versions could not be compared.');
    }
  }

  async function addLink() {
    if (!linkUrl.trim()) return;
    try {
      await knowledge.addLink(id, { url: linkUrl.trim() });
      setLinkUrl('');
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That link could not be added.');
    }
  }

  if (!article) {
    return (
      <>
        <div className="page-head">
          <h1>Article</h1>
        </div>
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} icon={<IconAlertCircle size={20} />} />
        ) : (
          <Loading label="Loading…" />
        )}
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>{article.title}</h1>
        <KnowledgeStatusChip status={article.status} />
      </div>
      <p className="page-sub">
        <Link to="/knowledge">← Knowledge</Link> · v{article.currentVersion} ·{' '}
        {describeKnowledgeStatus(article.status)}
      </p>

      {error && (
        <div className="alert" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}
      {notice && (
        <div className="card card-pad small" style={{ marginBottom: 16 }}>
          {notice}
        </div>
      )}

      <div className="card card-pad stack" style={{ marginBottom: 16 }}>
        <div>
          <label htmlFor="title">Title</label>
          <input
            id="title"
            value={draft.title}
            disabled={!canWrite}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor="summary">Summary</label>
          <input
            id="summary"
            value={draft.summary}
            disabled={!canWrite}
            placeholder="One line describing what this answers"
            onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor="body">Body (Markdown)</label>
          <textarea
            id="body"
            value={draft.body}
            disabled={!canWrite}
            rows={16}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            style={{
              width: '100%',
              font: 'inherit',
              padding: '9px 12px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--bg)',
              color: 'var(--text)',
            }}
          />
        </div>
        <div>
          <label htmlFor="category">Category</label>
          <select
            id="category"
            value={article.categoryId}
            disabled={!canWrite}
            onChange={(event) => void knowledge.updateArticle(id, { categoryId: event.target.value }).then(load)}
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <p className="hint">
            Scope: {article.scopeType}
            {article.scopeId ? ` · ${article.scopeId}` : ' — visible to every group'}
          </p>
        </div>

        {canWrite && (
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            {article.status === 'DRAFT' && (
              <button type="button" disabled={busy} onClick={() => void setStatus('REVIEW')}>
                Submit for review
              </button>
            )}
            {canApprove && article.status !== 'PUBLISHED' && article.status !== 'ARCHIVED' && (
              <button type="button" disabled={busy} onClick={() => void setStatus('PUBLISHED')}>
                Publish
              </button>
            )}
            {canApprove && article.status !== 'ARCHIVED' && (
              <button type="button" className="link" disabled={busy} onClick={() => void setStatus('ARCHIVED')}>
                Archive
              </button>
            )}
            {canApprove && (
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Delete this article and everything indexed from it?')) {
                    void knowledge.deleteArticle(id).then(() => navigate('/knowledge'));
                  }
                }}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      <div className="card card-pad stack" style={{ marginBottom: 16 }}>
        <h2>Links and videos</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          URLs are recorded as references. Nothing is downloaded, crawled or transcribed.
        </p>

        {(article.links ?? []).length === 0 ? (
          <p className="muted small">None yet.</p>
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {(article.links ?? []).map((link) => (
              <div key={link.id} className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <a href={link.url} target="_blank" rel="noreferrer noopener">
                    {link.title ?? link.url}
                  </a>
                  <span className="badge" style={{ marginLeft: 8 }}>
                    {link.kind}
                  </span>
                </div>
                {canWrite && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => void knowledge.removeLink(id, link.id).then(load)}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {canWrite && (
          <div className="row">
            <input
              placeholder="https://…"
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void addLink();
              }}
            />
            <button type="button" onClick={() => void addLink()}>
              Add
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-pad">
          <h2>Version history</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Change</th>
                <th>Status then</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.id}>
                  <td>v{version.version}</td>
                  <td className="small">{version.changeSummary ?? '—'}</td>
                  <td className="small">{version.status}</td>
                  <td className="small">
                    <RelativeTime value={version.createdAt} />
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button type="button" className="link" onClick={() => void showDiff(version.version)}>
                        Compare
                      </button>
                      {canApprove && version.version !== article.currentVersion && (
                        <button type="button" className="link" onClick={() => void rollback(version.version)}>
                          Restore
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {diff && (
        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>Comparison with the current version</h2>
            <button type="button" className="link" onClick={() => setDiff(null)}>
              Close
            </button>
          </div>
          <pre style={{ overflowX: 'auto', fontSize: 13, lineHeight: 1.5 }}>
            {diff.map((line, index) => (
              <div
                key={index}
                style={{
                  color:
                    line.type === 'added' ? 'var(--ok)' : line.type === 'removed' ? 'var(--danger)' : 'inherit',
                }}
              >
                {line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  '}
                {line.text}
              </div>
            ))}
          </pre>
        </div>
      )}
    </>
  );
}
