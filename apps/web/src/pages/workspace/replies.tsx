import { useState, type FormEvent } from 'react';
import { workspace } from '../../api/workspace';
import { useAuth } from '../../auth-context';
import { Card, Empty, ErrorState, Loading, PageHeader, errorMessage, useToast } from '../../components/ui';
import { Dialog, useResource } from './shared';

export function SavedRepliesPage() {
  const { can } = useAuth(); const toast = useToast(); const { data, busy, error, refresh } = useResource(workspace.replies);
  const [open, setOpen] = useState(false); const [saving, setSaving] = useState(false); const [search, setSearch] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (saving) return; const f = new FormData(e.currentTarget); setSaving(true);
    try { await workspace.saveReply(String(f.get('title')), String(f.get('body'))); setOpen(false); toast.success('Saved reply created.'); await refresh(); }
    catch (e) { toast.error(errorMessage(e, 'Could not save reply.')); } finally { setSaving(false); }
  }
  return <><PageHeader title="Saved replies" description="Your best answers, ready when you need them. Available in the inbox composer." actions={can('messages.send') && <button className="primary" onClick={() => setOpen(true)}>+ New reply</button>} /><div className="workspace-toolbar"><input placeholder="Search saved replies…" aria-label="Search saved replies" value={search} onChange={e => setSearch(e.target.value)} /><span className="muted small">Private to your account</span></div>{error && <ErrorState message={error} onRetry={() => void refresh()} />}{busy && !data ? <Loading /> : <div className="team-card-grid">{data?.items.filter(r => `${r.title} ${r.body}`.toLowerCase().includes(search.toLowerCase())).map(r => <Card key={r.id} title={r.title}><p className="reply-preview">{r.body}</p>{can('messages.send') && <button onClick={() => { if (window.confirm(`Delete saved reply “${r.title}”?`)) void workspace.deleteReply(r.id).then(() => refresh()).catch(e => toast.error(errorMessage(e, 'Could not delete reply.'))); }}>Delete</button>}</Card>)}</div>}{data && !data.items.length && <Empty title="Make a good answer reusable" hint="Save greetings, troubleshooting steps, or follow-up messages." />}{open && <Dialog title="New saved reply" onClose={() => { if (!saving) setOpen(false); }}><form className="workspace-form" onSubmit={e => void submit(e)}><label>Title<input name="title" required maxLength={120} placeholder="A friendly welcome" /></label><label>Message<textarea rows={6} name="body" required maxLength={8000} /></label><div className="dialog-actions"><button type="button" disabled={saving} onClick={() => setOpen(false)}>Cancel</button><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save reply'}</button></div></form></Dialog>}</>;
}
