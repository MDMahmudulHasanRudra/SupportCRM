import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { knowledge, type KnowledgeCandidate, type KnowledgeCategory } from '../../api/client';
import { useAuth } from '../../auth-context';
import { RelativeTime } from '../../components/status-badge';

/**
 * The knowledge gap queue (`PROJECT_SPEC.md` §75).
 *
 * Questions customers keep asking that nothing answers. In this phase every entry is raised by a
 * person — the specification's automatic source is repeated AI escalation, which does not exist
 * yet — and converting one produces a **draft** for somebody to write, never a published answer.
 */
export function KnowledgeCandidatesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();

  const [candidates, setCandidates] = useState<KnowledgeCandidate[] | null>(null);
  const [categories, setCategories] = useState<KnowledgeCategory[]>([]);
  const [filter, setFilter] = useState('OPEN');
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canWrite = can('knowledge.create');

  const load = useCallback(async () => {
    try {
      const [list, categoryList] = await Promise.all([
        knowledge.candidates(filter || undefined),
        knowledge.categories(),
      ]);
      setCandidates(list.items);
      setCategories(categoryList.items);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The gap queue could not be loaded.');
      setCandidates([]);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function record() {
    if (!question.trim()) return;
    try {
      await knowledge.createCandidate({ question: question.trim() });
      setQuestion('');
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That gap could not be recorded.');
    }
  }

  async function convert(candidate: KnowledgeCandidate) {
    const categoryId = categories[0]?.id;
    if (!categoryId) return;

    try {
      const result = await knowledge.convertCandidate(candidate.id, categoryId);
      navigate(`/knowledge/articles/${result.article.id}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That candidate could not be converted.');
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Knowledge gaps</h1>
        <select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="OPEN">Open</option>
          <option value="CONVERTED">Converted</option>
          <option value="DISMISSED">Dismissed</option>
          <option value="">All</option>
        </select>
      </div>
      <p className="page-sub">
        <Link to="/knowledge">← Knowledge</Link> · Questions with no written answer. Converting one
        creates a draft article for you to write.
      </p>

      {error && (
        <div className="alert" style={{ marginBottom: 'var(--space-7)' }}>
          {error}
        </div>
      )}

      {canWrite && (
        <div className="card card-pad" style={{ marginBottom: 'var(--space-7)' }}>
          <div className="row">
            <input
              placeholder="What are customers asking that we cannot answer?"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void record();
              }}
            />
            <button type="button" onClick={() => void record()}>
              Record gap
            </button>
          </div>
          <p className="hint">Recording the same question again raises its count rather than adding a duplicate.</p>
        </div>
      )}

      <div className="card">
        {candidates === null ? (
          <div className="empty">Loading…</div>
        ) : candidates.length === 0 ? (
          <div className="empty">
            <h2>Nothing here</h2>
            <p>No knowledge gaps recorded with this filter.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Question</th>
                  <th>Asked</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Recorded</th>
                  {canWrite && <th />}
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate) => (
                  <tr key={candidate.id}>
                    <td>
                      <div>{candidate.question}</div>
                      {candidate.context && <div className="muted small">{candidate.context.slice(0, 120)}</div>}
                    </td>
                    <td>{candidate.occurrences}×</td>
                    <td className="small">{candidate.sourceType === 'MANUAL' ? 'Reported' : 'Escalation'}</td>
                    <td className="small">
                      {candidate.status}
                      {candidate.convertedArticleId && (
                        <>
                          {' · '}
                          <Link to={`/knowledge/articles/${candidate.convertedArticleId}`}>article</Link>
                        </>
                      )}
                    </td>
                    <td className="small">
                      <RelativeTime value={candidate.createdAt} />
                    </td>
                    {canWrite && (
                      <td>
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          {candidate.status === 'OPEN' && (
                            <>
                              <button type="button" className="primary" onClick={() => void convert(candidate)}>
                                Write it
                              </button>
                              <button
                                type="button"
                                className="link"
                                onClick={() => void knowledge.dismissCandidate(candidate.id).then(load)}
                              >
                                Dismiss
                              </button>
                            </>
                          )}
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
  );
}
