import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { errorMessage } from '../../components/ui';

export function useResource<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++revision.current; setBusy(true);
    try { const result = await loader(); if (id === revision.current) { setData(result); setError(null); } }
    catch (e) { if (id === revision.current) setError(errorMessage(e, 'Could not load this page.')); }
    finally { if (id === revision.current) setBusy(false); }
  }, [loader]);
  useEffect(() => { void refresh(); const counter = revision; return () => { counter.current++; }; }, [refresh]);
  return { data, error, busy, refresh };
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; el?.showModal(); return () => { el?.close(); }; }, []);
  return createPortal(<dialog ref={ref} className="workspace-dialog" aria-labelledby="workspace-dialog-title" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) onClose(); }}><div className="workspace-dialog-head"><h2 id="workspace-dialog-title">{title}</h2><button aria-label="Close dialog" onClick={onClose}>×</button></div>{children}</dialog>, document.body);
}

/** A local CSV download; callers must have the relevant export permission. */
export function downloadCsv(name: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const quote = (v: unknown) => { const text = String(v ?? ''); return `"${(/^[=+\-@\t\r]/.test(text) ? "'" : '') + text.replace(/"/g, '""')}"`; };
  const keys = Object.keys(rows[0]);
  const csv = '\uFEFF' + [keys.map(quote).join(','), ...rows.map(row => keys.map(key => quote(row[key])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
