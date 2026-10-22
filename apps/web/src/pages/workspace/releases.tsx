import { useCallback, useState, type FormEvent } from 'react';
import { shortDate, workspace, type HistoryEntry, type Release } from '../../api/workspace';
import { useAuth } from '../../auth-context';
import { Badge, Card, Empty, ErrorState, Loading, PageHeader, errorMessage, useToast } from '../../components/ui';
import { Dialog, useResource } from './shared';

export function ReleasesPage() {
  const { can } = useAuth();
  const manage = can('settings.manage');
  const toast = useToast();
  const loader = useCallback(() => workspace.releases(manage), [manage]);
  const { data, busy, error, refresh } = useResource(loader);
  const [editing, setEditing] = useState<Release | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<{ releaseId: string; items: HistoryEntry[] } | null>(null);
  const [restoreId, setRestoreId] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    const f = new FormData(e.currentTarget);
    const dto = { version: String(f.get('version')), title: String(f.get('title')), body: String(f.get('body')) };
    try {
      if (editing === 'new') await workspace.release(dto);
      else if (editing) await workspace.updateRelease(editing.id, { ...dto, status: String(f.get('status')) });
      setEditing(null);
      toast.success('Release saved.');
      await refresh();
    } catch (e) { toast.error(errorMessage(e, 'Could not save release.')); }
    finally { setSaving(false); }
  }
  async function openHistory(id: string) {
    try {
      const result = await workspace.releaseHistory(id);
      setRestoreId(null);
      setHistory({ releaseId: id, items: result.items });
    } catch (e) { toast.error(errorMessage(e, 'Could not load history.')); }
  }
  async function restore() {
    if (!history || !restoreId || saving) return;
    setSaving(true);
    try {
      await workspace.restoreRelease(history.releaseId, restoreId);
      setHistory(null);
      setRestoreId(null);
      toast.success('Version restored as a draft. Review it before publishing.');
      await refresh();
    } catch (e) { toast.error(errorMessage(e, 'Could not restore this version.')); }
    finally { setSaving(false); }
  }
  return <>
    <PageHeader title="What’s new" description="Small improvements. Better support, every day." actions={manage && <button className="primary" onClick={() => setEditing('new')}>+ Draft release</button>} />
    {error && <ErrorState message={error} onRetry={() => void refresh()} />}
    {busy && !data ? <Loading /> : <div className="release-feed">{data?.items.map(r => <article className="release-entry" key={r.id}>
      <aside><span className="release-version">{r.version}</span><small className="muted">{shortDate(r.publishedAt || r.createdAt)}</small></aside>
      <Card title={r.title} actions={manage && <Badge tone={r.status === 'PUBLISHED' ? 'ok' : 'neutral'}>{r.status}</Badge>}>
        <p className="release-body">{r.body}</p>
        {manage && <div className="row"><button onClick={() => setEditing(r)}>Edit / publish</button><button onClick={() => void openHistory(r.id)}>Edit history</button></div>}
      </Card>
    </article>)}</div>}
    {data && !data.items.length && <Empty title="A new chapter starts here" hint={manage ? 'Draft a release and publish it when it’s ready. Your team will receive a notification.' : 'Published product updates will appear here.'} />}
    {editing && <Dialog title={editing === 'new' ? 'Draft release' : 'Edit release'} onClose={() => { if (!saving) setEditing(null); }}>
      <form className="workspace-form" onSubmit={e => void submit(e)}>
        <label>Version<input name="version" required maxLength={40} defaultValue={editing === 'new' ? '' : editing.version} placeholder="v1.0.0" /></label>
        <label>Title<input name="title" required maxLength={190} defaultValue={editing === 'new' ? '' : editing.title} /></label>
        <label>Release notes<textarea name="body" rows={8} required maxLength={20000} defaultValue={editing === 'new' ? '' : editing.body} /></label>
        {editing !== 'new' && <label>Status<select name="status" defaultValue={editing.status}><option>DRAFT</option><option>PUBLISHED</option><option>ARCHIVED</option></select><small className="muted">Publishing sends an in-app announcement to active users.</small></label>}
        <div className="dialog-actions"><button type="button" disabled={saving} onClick={() => setEditing(null)}>Cancel</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save release'}</button></div>
      </form>
    </Dialog>}
    {history && <Dialog title="Release edit history" onClose={() => { if (!saving) setHistory(null); }}>
      <p className="muted">Restore a previous version as a draft. Your current version stays in this history.</p>
      {history.items.length ? history.items.map(h => {
        const snapshot = h.snapshot as Partial<Release> | undefined;
        return <section className="release-history-entry" key={h.id}>
          <div className="row"><strong>{snapshot?.version} · {snapshot?.title}</strong><small className="muted">{new Date(h.createdAt).toLocaleString()}</small></div>
          <p className="release-body">{snapshot?.body}</p>
          {restoreId === h.id ? <div className="stack" role="group" aria-label="Confirm version restore">
            <p>Restore this version? The release becomes a draft and will be hidden from the published feed until you publish it again. No announcement is sent now.</p>
            <div className="row"><button disabled={saving} onClick={() => setRestoreId(null)}>Keep current version</button><button className="primary" disabled={saving} onClick={() => void restore()}>{saving ? 'Restoring…' : 'Confirm restore as draft'}</button></div>
          </div> : <button disabled={saving} onClick={() => setRestoreId(h.id)}>Restore as draft</button>}
        </section>;
      }) : <Empty title="No previous edits" />}
    </Dialog>}
  </>;
}
