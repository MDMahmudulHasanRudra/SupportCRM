import { useEffect, useRef, useState } from 'react';
import { ApiError, customers } from '../api/client';
import { customerDirectory, type ImportPreview } from '../api/customer-directory';
import { Dialog } from '../pages/workspace/shared';
import { Badge, ErrorState, TableWrap, errorMessage, useToast } from './ui';

export function CustomerImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [csv, setCsv] = useState(''); const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null); const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const pending = useRef(false); const revision = useRef(0); const toast = useToast();
  useEffect(() => { const ref = revision; return () => { ref.current++; }; },[]);
  async function choose(file?: File) {
    const id = ++revision.current; setPreview(null); setCsv(''); setAck(false); setError(null); setFileName(file?.name || '');
    if (!file) return;
    if (file.size > 512*1024) { setError('Choose a UTF-8 CSV of at most 512 KiB and 250 records.'); return; }
    try { const text = new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()); if (id === revision.current) setCsv(text); }
    catch { if (id === revision.current) setError('This file is not valid UTF-8 CSV. Export it as UTF-8 CSV and try again.'); }
  }
  async function review() {
    if (pending.current || !csv) return; pending.current=true; setBusy(true); setError(null);
    try { setPreview(await customerDirectory.preview(csv)); setAck(false); }
    catch(e) { setError(errorMessage(e,'Could not preview this file.')); }
    finally { pending.current=false; setBusy(false); }
  }
  async function commit() {
    if (pending.current || !preview?.previewToken || !preview.valid || (preview.warningCount>0 && !ack)) return;
    pending.current=true; setBusy(true); setError(null);
    try { const result = await customerDirectory.commit(csv,preview.previewToken,ack); toast.success(`${result.createdCount} customers imported${result.replayed ? ' (previous request confirmed)' : ''}.`); onImported(); }
    catch(e) { setError(errorMessage(e,'Could not import. You can retry safely.')); if(e instanceof ApiError && [400,409].includes(e.status)) { setPreview(null); setAck(false); } }
    finally { pending.current=false; setBusy(false); }
  }
  return <Dialog title="Import customers" onClose={() => { if (!pending.current) onClose(); }}><div className="stack">
    <p className="muted">Create new customers from a CSV. Existing customers and channel identities stay separate. Preview every row before importing.</p>
    <a className="button-link" href={customers.templateUrl}>Download CSV template</a>
    <p className="small muted">Use up to 250 records / 512 KiB. Name is required. Other columns: code, phone, email, company, country, service, ownerUsername, status. Leave code empty for automatic numbering; ownerUsername must be an active dashboard username.</p>
    <label>UTF-8 CSV file<input type="file" accept=".csv,text/csv" disabled={busy} onChange={e=>void choose(e.target.files?.[0])} /></label>
    {fileName && <span className="small muted">{fileName}</span>}
    {error && <ErrorState message={error} />}
    {preview && <><div className="row"><Badge tone={preview.valid ? 'ok' : 'bad'}>{preview.rows.length} records / {preview.valid ? 'Ready to review' : 'Corrections needed'}</Badge><Badge tone={preview.warningCount ? 'warn' : 'neutral'}>{preview.warningCount} shared-contact records</Badge></div><TableWrap><table><thead><tr><th>Record</th><th>Customer / code</th><th>Contact / context</th><th>Validation</th></tr></thead><tbody>{preview.rows.map(r=><tr key={r.record}><td>{r.record}</td><td><strong>{r.values.name}</strong><div className="small muted">{r.values.code || 'Automatic code'}</div></td><td className="customer-import-context">{[r.values.phone,r.values.email,r.values.company,r.values.country,r.values.service,r.values.ownerUsername,r.values.status || 'ACTIVE'].filter(Boolean).map((v,i)=><div key={i}>{v}</div>)}</td><td>{r.errors.map((e,i)=><p className="customer-validation-error" key={`e${i}`}>{e}</p>)}{r.warnings.map((w,i)=><p className="customer-validation-warning" key={`w${i}`}>{w}</p>)}{!r.errors.length && !r.warnings.length && <span>Valid</span>}</td></tr>)}</tbody></table></TableWrap>
      {preview.valid && <p className="small muted">Preview expires at {new Date(preview.expiresAt).toLocaleTimeString()}. Import creates all records together. Reusing this preview after a timeout confirms the same import.</p>}
      {preview.valid && preview.warningCount>0 && <label className="row"><input type="checkbox" checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)} /> I reviewed the shared contacts and want separate customer records.</label>}
    </>}
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>Cancel</button><button disabled={busy || !csv} onClick={()=>void review()}>{busy ? 'Working…' : 'Preview file'}</button>{preview?.valid && <button className="primary" disabled={busy || (preview.warningCount>0 && !ack)} onClick={()=>void commit()}>Import {preview.rows.length} customers</button>}</div>
  </div></Dialog>;
}
