import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  knowledge,
  type KnowledgeArticle,
  type KnowledgeCategory,
  type KnowledgeDocumentRow,
  type KnowledgeStatusReport,
  type RetrievedChunk,
} from '../../api/client';
import { useAuth } from '../../auth-context';
import { IconBookOpen, IconInbox } from '../../components/icons';
import { RelativeTime } from '../../components/status-badge';
import { Empty } from '../../components/ui';
import { KnowledgeStatusChip, DocumentStatusChip } from './status-chips';
import { UploadPanel } from './upload-panel';

/**
 * The knowledge browser.
 *
 * Two things share this page because operators use them together: the article list they maintain,
 * and a search box that runs the *same* retrieval the system will use later. Seeing what a search
 * actually returns — and whether semantic search is even on — is the fastest way to tell whether
 * the knowledge base is doing its job.
 */
export function KnowledgeBrowserPage() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const [status, setStatus] = useState<KnowledgeStatusReport | null>(null);
  const [categories, setCategories] = useState<KnowledgeCategory[]>([]);
  const [articles, setArticles] = useState<KnowledgeArticle[] | null>(null);
  const [documents, setDocuments] = useState<KnowledgeDocumentRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [filter, setFilter] = useState<{ status: string; categoryId: string; search: string }>({
    status: '',
    categoryId: '',
    search: '',
  });

  const [tab, setTab] = useState<'articles' | 'documents' | 'search'>('articles');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<{ chunks: RetrievedChunk[]; semanticAvailable: boolean } | null>(null);
  const [searching, setSearching] = useState(false);

  const canWrite = can('knowledge.create');

  const load = useCallback(async () => {
    try {
      const [statusReport, categoryList, articleList, documentList] = await Promise.all([
        knowledge.status(),
        knowledge.categories(),
        knowledge.listArticles({
          status: filter.status || undefined,
          categoryId: filter.categoryId || undefined,
          search: filter.search || undefined,
        }),
        knowledge.documents(),
      ]);

      setStatus(statusReport);
      setCategories(categoryList.items);
      setArticles(articleList.items);
      setDocuments(documentList.items);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load the knowledge base.');
      setArticles([]);
    }
  }, [filter.status, filter.categoryId, filter.search]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setError(null);

    try {
      const result = await knowledge.search({
        query: searchQuery,
        // A writer searching their own drafts is an explicit, permissioned choice.
        includeUnpublished: canWrite,
        limit: 10,
      });
      setResults(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That search could not be run.');
    } finally {
      setSearching(false);
    }
  }

  async function createArticle() {
    const category = filter.categoryId || categories[0]?.id;
    if (!category) return;

    try {
      const article = await knowledge.createArticle({ title: 'Untitled article', categoryId: category });
      navigate(`/knowledge/articles/${article.id}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The article could not be created.');
    }
  }

  const categoryName = (id: string) => categories.find((c) => c.id === id)?.name ?? '—';

  return (
    <>
      <div className="page-head">
        <h1>Knowledge</h1>
        <div className="row">
          <Link to="/knowledge/candidates" className="small">
            Gap queue →
          </Link>
          {canWrite && (
            <button type="button" className="primary" onClick={() => void createArticle()}>
              + New article
            </button>
          )}
        </div>
      </div>
      <p className="page-sub">
        {status
          ? `${status.articles.published} published of ${status.articles.total} articles · ${status.documents.indexed} of ${status.documents.total} documents indexed`
          : 'Loading…'}
      </p>

      {/* Whether semantic search is on is stated plainly. Keyword-only results presented as the
          whole answer would quietly mislead whoever relies on them. */}
      {status && !status.embedding.available && (
        <div className="card card-pad small" style={{ marginBottom: 16 }}>
          <strong>Semantic search is off.</strong> No embedding provider is configured, so search
          matches on words rather than meaning. Documents still index and remain searchable.
        </div>
      )}

      {error && (
        <div className="alert" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div className="row" style={{ marginBottom: 14, gap: 6 }}>
        {(['articles', 'documents', 'search'] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={tab === name ? 'primary' : ''}
            onClick={() => setTab(name)}
          >
            {name === 'articles' ? 'Articles' : name === 'documents' ? 'Documents' : 'Search'}
          </button>
        ))}
      </div>

      {tab === 'articles' && (
        <>
          <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
            <input
              placeholder="Search titles…"
              value={filter.search}
              style={{ maxWidth: 260 }}
              onChange={(event) => setFilter({ ...filter, search: event.target.value })}
            />
            <select
              value={filter.status}
              onChange={(event) => setFilter({ ...filter, status: event.target.value })}
            >
              <option value="">Any status</option>
              {['DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <select
              value={filter.categoryId}
              onChange={(event) => setFilter({ ...filter, categoryId: event.target.value })}
            >
              <option value="">Any category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="card">
            {articles === null ? (
              <div className="empty">Loading…</div>
            ) : articles.length === 0 ? (
              <Empty
                title="No articles yet"
                hint="Write one, or upload a document to index."
                icon={<IconBookOpen size={20} />}
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Category</th>
                      <th>Status</th>
                      <th>Scope</th>
                      <th>Version</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {articles.map((article) => (
                      <tr key={article.id}>
                        <td>
                          <Link to={`/knowledge/articles/${article.id}`}>{article.title}</Link>
                          {article.summary && <div className="muted small">{article.summary.slice(0, 90)}</div>}
                        </td>
                        <td className="small">{categoryName(article.categoryId)}</td>
                        <td>
                          <KnowledgeStatusChip status={article.status} />
                        </td>
                        <td className="small">{article.scopeType}</td>
                        <td className="small">v{article.currentVersion}</td>
                        <td className="small">
                          <RelativeTime value={article.updatedAt} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'documents' && (
        <>
          {canWrite && categories.length > 0 && (
            <UploadPanel categories={categories} onUploaded={() => void load()} />
          )}

          <div className="card">
            {documents.length === 0 ? (
              <Empty
                title="No documents yet"
                hint="Upload a PDF, Word document, text file or Markdown to index it."
                icon={<IconInbox size={20} />}
              />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Category</th>
                      <th>Status</th>
                      <th>Chunks</th>
                      <th>Uploaded</th>
                      {canWrite && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {documents.map((document) => (
                      <tr key={document.id}>
                        <td>
                          <a href={knowledge.downloadUrl(document.id)}>{document.filename}</a>
                          <div className="muted small">
                            {document.mimeType} · {Math.max(1, Math.round(document.sizeBytes / 1024))} KB
                          </div>
                        </td>
                        <td className="small">{categoryName(document.categoryId)}</td>
                        <td>
                          <DocumentStatusChip status={document.status} />
                          {document.statusDetail && (
                            <div className="muted small" style={{ marginTop: 4, maxWidth: 320 }}>
                              {document.statusDetail}
                            </div>
                          )}
                        </td>
                        <td className="small">{document.chunkCount}</td>
                        <td className="small">
                          <RelativeTime value={document.createdAt} />
                        </td>
                        {canWrite && (
                          <td>
                            <div className="row" style={{ justifyContent: 'flex-end' }}>
                              <button
                                type="button"
                                className="link"
                                onClick={() => void knowledge.reprocess(document.id).then(load)}
                              >
                                Re-index
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {tab === 'search' && (
        <div className="stack">
          <div className="card card-pad">
            <div className="row">
              <input
                placeholder="Ask the knowledge base a question…"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void runSearch();
                }}
              />
              {/* Not just "Search": the tab above is also called Search, and two identical labels
                  on one screen is a small ambiguity that costs somebody a moment every time. */}
              <button type="button" className="primary" disabled={searching} onClick={() => void runSearch()}>
                {searching ? 'Searching…' : 'Run search'}
              </button>
            </div>
            <p className="hint">
              This is the same retrieval the support system uses. {canWrite ? 'Your drafts are included here; they are never included for customers.' : 'Published knowledge only.'}
            </p>
          </div>

          {results && (
            <div className="card">
              {results.chunks.length === 0 ? (
                <Empty title="Nothing matched." icon={<IconInbox size={20} />} />
              ) : (
                <div className="stack card-pad">
                  {results.chunks.map((chunk) => (
                    <div key={chunk.chunkId} className="stack" style={{ gap: 4 }}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <strong>
                          {chunk.articleId ? (
                            <Link to={`/knowledge/articles/${chunk.articleId}`}>{chunk.title ?? 'Article'}</Link>
                          ) : (
                            (chunk.heading ?? 'Document passage')
                          )}
                        </strong>
                        <span className="badge">
                          {chunk.matchedBy} · {chunk.scopeType} · score {chunk.score.toFixed(2)}
                        </span>
                      </div>
                      <div className="small muted">{chunk.content.slice(0, 400)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
