import { useRef, useState } from 'react';
import { knowledge, type KnowledgeCategory } from '../../api/client';

/**
 * Document upload with real progress.
 *
 * Progress comes from the request itself, not from a spinner that means nothing — a 25 MB PDF on a
 * slow link is a long silence otherwise. Once the bytes are up, indexing happens on the queue, so
 * the panel says so rather than implying the work is finished.
 */
export function UploadPanel({
  categories,
  onUploaded,
  articleId,
}: {
  categories: KnowledgeCategory[];
  onUploaded: () => void;
  articleId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(file: File) {
    setError(null);
    setMessage(null);
    setProgress(0);

    try {
      const result = await knowledge.upload(file, { categoryId, articleId }, setProgress);
      setMessage(
        result.duplicate
          ? `${file.name} is already in this category — the existing copy was kept.`
          : `${file.name} uploaded. Indexing runs in the background; the status updates when it finishes.`,
      );
      onUploaded();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That file could not be uploaded.');
    } finally {
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="card card-pad stack" style={{ marginBottom: 16 }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} style={{ maxWidth: 200 }}>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>

        <input
          ref={input}
          type="file"
          accept=".pdf,.docx,.txt,.md,.markdown,.html,.htm,.png,.jpg,.jpeg,.webp"
          disabled={progress !== null || !categoryId}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void send(file);
          }}
        />
      </div>

      {progress !== null && (
        <div className="progress">
          <span className="spinner" aria-hidden="true" />
          <span>Uploading… {progress}%</span>
        </div>
      )}
      {message && <div className="small muted">{message}</div>}
      {error && <div className="alert">{error}</div>}

      <p className="hint">
        PDF, Word, text, Markdown and HTML are indexed for search. Images are stored and downloadable
        but not searchable — there is no text extraction from images.
      </p>
    </div>
  );
}
