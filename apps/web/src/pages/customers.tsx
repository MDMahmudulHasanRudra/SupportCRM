import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  customers as customersApi,
  type Customer,
  type CustomerStatusValue,
  type CustomerIdentity,
  type CustomerNote,
  type CustomerWithTags,
} from '../api/client';
import { useAuth } from '../auth-context';
import { CustomerImportDialog } from '../components/customer-import';
import { CustomerFields, customerBusinessFields } from '../components/customer-fields';
import { Dialog } from './workspace/shared';
import { IconAlertCircle, IconUserCircle, IconUsers } from '../components/icons';
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  RelativeTime,
  Skeleton,
  errorMessage,
  humanise,
  useToast,
} from '../components/ui';

/**
 * Customers (Phase 3 brief §1, §2, §9, §13, §14).
 *
 * A business relationship, never a phone number — the same distinction the backend draws. A
 * customer can be linked to several channel identities, which is why the detail pane shows them
 * separately rather than folding a phone number into the customer record itself.
 */
export function CustomersPage() {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can('customers.manage');

  const [items, setItems] = useState<Customer[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(''); const [country, setCountry] = useState(''); const [owner, setOwner] = useState('');
  const [offset, setOffset] = useState(0); const [total, setTotal] = useState(0); const [listBusy, setListBusy] = useState(false);
  const [owners, setOwners] = useState<Array<{id:string;name:string}>>([]);
  const [importing, setImporting] = useState(false);
  const listRevision = useRef(0); const detailRevision = useRef(0); const selectedRef = useRef<string | null>(null);
  const filters = { search: search || undefined, status: (status || undefined) as CustomerStatusValue | undefined, country: country.length === 2 ? country : undefined, accountOwnerId: owner && owner !== 'unassigned' ? owner : undefined, unassigned: owner === 'unassigned' ? 'true' : undefined };
  const canImport = canManage && can('customers.read') && can('customers.import');
  useEffect(() => { let active=true; if(canManage) void customersApi.owners().then(p=>{if(active) setOwners(p.items);}).catch(()=>undefined); return()=>{active=false;}; },[canManage]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerWithTags | null>(null);
  const [identities, setIdentities] = useState<CustomerIdentity[] | null>(null);
  const [notes, setNotes] = useState<CustomerNote[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const loadList = useCallback(async () => {
    const revision=++listRevision.current; setListBusy(true);
    try {
      const page = await customersApi.list({ search: search || undefined, status: (status || undefined) as CustomerStatusValue | undefined, country: country.length === 2 ? country : undefined, accountOwnerId: owner && owner !== 'unassigned' ? owner : undefined, unassigned: owner === 'unassigned' ? 'true' : undefined, limit: 50, offset });
      if(revision!==listRevision.current) return;
      setItems(page.items); setTotal(page.total);
      setListError(null);
    } catch (failure) {
      if(revision===listRevision.current) setListError(errorMessage(failure, 'Customers could not be loaded.'));
    } finally { if(revision===listRevision.current) setListBusy(false); }
  }, [search,status,country,owner,offset]);

  useEffect(() => {
    const counter = listRevision;
    const timer = window.setTimeout(() => void loadList(), 250);
    return () => { window.clearTimeout(timer); counter.current++; };
  }, [loadList]);

  const loadDetail = useCallback(async (id: string) => {
    const revision=++detailRevision.current;
    try {
      const [customer, identityPage, notePage] = await Promise.all([
        customersApi.get(id),
        customersApi.identities(id),
        customersApi.notes(id),
      ]);
      if(revision!==detailRevision.current || selectedRef.current!==id) return;
      setDetail(customer);
      setIdentities(identityPage.items);
      setNotes(notePage.items);
      setDetailError(null);
    } catch (failure) {
      if(revision===detailRevision.current && selectedRef.current===id) setDetailError(errorMessage(failure, 'This customer could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    const counter = detailRevision;
    if (selectedId) void loadDetail(selectedId);
    return()=>{counter.current++;};
  }, [selectedId, loadDetail]);

  function selectCustomer(id: string) { if(selectedRef.current===id) return; selectedRef.current=id; detailRevision.current++; setDetail(null); setIdentities(null); setNotes(null); setDetailError(null); setNoteDraft(''); setSelectedId(id); }

  async function submitNote() {
    if (!selectedId || !noteDraft.trim()) return;
    const customerId=selectedId; setSavingNote(true);
    try {
      await customersApi.addNote(customerId, noteDraft.trim());
      if(selectedRef.current===customerId) { setNoteDraft(''); await loadDetail(customerId); }
    } catch (failure) {
      toast.error(errorMessage(failure, 'The note could not be saved.'));
    } finally {
      setSavingNote(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Customers"
        description="The business relationships behind the conversations — never just a phone number."
        actions={<>{can('customers.read') && can('customers.export') && <a className="button-link" href={customersApi.exportUrl(filters)} target="_blank" rel="noreferrer">Export matching CSV</a>}{canImport && <button onClick={()=>setImporting(true)}>Import customers</button>}{canManage && <button type="button" className="primary" onClick={()=>setShowCreate(true)}>+ New customer</button>}</>}
      />

      <div className="customer-directory-filters">
        <label>Status<select value={status} onChange={e=>{setStatus(e.target.value);setOffset(0);}}><option value="">All statuses</option><option>ACTIVE</option><option>PROSPECT</option><option>INACTIVE</option></select></label>
        <label>Country (ISO)<input value={country} maxLength={2} placeholder="All" onChange={e=>{setCountry(e.target.value.toUpperCase());setOffset(0);}} /></label>
        {canManage && <label>Account owner<select value={owner} onChange={e=>{setOwner(e.target.value);setOffset(0);}}><option value="">All owners</option><option value="unassigned">Unassigned</option>{owners.map(o=><option value={o.id} key={o.id}>{o.name}</option>)}</select></label>}
        <span className="small muted" aria-live="polite">{listBusy ? 'Loading customers...' : `${total} matching customers`}</span>
      </div>
      <div className="customers-shell">
        <div className="inbox-pane" style={{ height: 'calc(100vh - 160px)', minHeight: 420 }}>
          <div className="inbox-search">
            <input aria-label="Search customers" placeholder="Search code, name, phone, email…" value={search} onChange={(event) =>  { setSearch(event.target.value); setOffset(0); }} />
          </div>
          <div className="inbox-list">
            {listError && (
              <div style={{ padding: 14 }}>
                <ErrorState message={listError} onRetry={() => void loadList()} icon={<IconAlertCircle />} />
              </div>
            )}
            {!items && !listError && (
              <div style={{ padding: 14 }}>
                <Skeleton lines={8} height={40} />
              </div>
            )}
            {items && items.length === 0 && (
              <Empty title="No customers" hint="Nothing matches this search yet." icon={<IconUsers />} />
            )}
            {items?.map((customer) => (
              <button
                key={customer.id}
                type="button"
                className={customer.id === selectedId ? 'customer-row active' : 'customer-row'}
                onClick={() => selectCustomer(customer.id)}
              >
                <div className="customer-row-name">{customer.displayName}</div><div className="small muted">{customer.code} / {customer.serviceName || humanise(customer.status)}</div>
                <div className="customer-row-meta">{customer.primaryPhone ?? customer.email ?? customer.company ?? '—'}</div>
              </button>
            ))}
          </div>
          <div className="customer-pagination"><span className="small muted">{items?.length ? offset+1 : 0}-{offset+(items?.length || 0)} of {total}</span><button disabled={listBusy || offset===0} onClick={()=>setOffset(n=>Math.max(0,n-50))}>Previous</button><button disabled={listBusy || offset+50>=total} onClick={()=>setOffset(n=>n+50)}>Next</button></div>
        </div>

        <div className="stack">
          {!selectedId && (
            <Card>
              <Empty
                title="Select a customer"
                hint="Pick one from the list to see their identities, notes and tags."
                icon={<IconUserCircle />}
              />
            </Card>
          )}
          {selectedId && detailError && (
            <ErrorState message={detailError} onRetry={() => void loadDetail(selectedId)} icon={<IconAlertCircle />} />
          )}
          {selectedId && !detail && !detailError && (
            <Card>
              <Loading label="Loading…" />
            </Card>
          )}

          {detail && (
            <>
              <Card
                title={detail.displayName}
                  actions={<><Link to={`/customers/${detail.id}`} className="small">Client 360° ↗</Link><Badge tone={detail.status === 'ACTIVE' ? 'ok' : 'neutral'}>{humanise(detail.status)}</Badge></>}
              >
                <dl className="client-facts"><dt>Client code</dt><dd>{detail.code}</dd><dt>Country</dt><dd>{detail.country || 'Not set'}</dd><dt>Service</dt><dd>{detail.serviceName || 'Not set'}</dd><dt>Account owner</dt><dd>{detail.accountOwner?.name || 'Unassigned'}{detail.accountOwner?.isActive === false && ' (inactive)'}</dd></dl>
                <div className="form-grid">
                  <div>
                    <div className="muted small">Phone</div>
                    <div>{detail.primaryPhone ?? '—'}</div>
                  </div>
                  <div>
                    <div className="muted small">Email</div>
                    <div>{detail.email ?? '—'}</div>
                  </div>
                  <div>
                    <div className="muted small">Company</div>
                    <div>{detail.company ?? '—'}</div>
                  </div>
                  <div>
                    <div className="muted small">Source</div>
                    <div>{humanise(detail.source)}</div>
                  </div>
                </div>
                {detail.tags.length > 0 && (
                  <div className="chip-row">
                    {detail.tags.map((tag) => (
                      <Badge key={tag.id}>{tag.label}</Badge>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="Channel identities">
                {!identities || identities.length === 0 ? (
                  <div className="muted small">No channel identity has been confirmed for this customer yet.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Channel</th>
                          <th>Phone</th>
                          <th>State</th>
                          <th>Last seen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {identities.map((identity) => (
                          <tr key={identity.id}>
                            <td>{identity.channelKey}</td>
                            <td>{identity.phone}</td>
                            <td>
                              <Badge tone={identity.matchState === 'CONFIRMED' ? 'ok' : identity.matchState === 'REJECTED' ? 'bad' : 'neutral'}>
                                {humanise(identity.matchState)}
                              </Badge>
                            </td>
                            <td className="small muted">
                              <RelativeTime value={identity.lastSeenAt} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <Card title="Notes">
                <div className="stack">
                  {notes && notes.length === 0 && <div className="muted small">No notes yet.</div>}
                  {notes?.map((note) => (
                    <div key={note.id} className="card card-pad" style={{ background: 'var(--surface-2)' }}>
                      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{note.body}</div>
                      <div className="muted small" style={{ marginTop: 6 }}>
                        {note.authorUsername ?? 'Someone'} · <RelativeTime value={note.createdAt} />
                      </div>
                    </div>
                  ))}
                  {canManage && (
                    <div className="row">
                      <textarea
                        rows={2}
                        placeholder="Add an internal note — never sent to the customer or to AI…"
                        value={noteDraft}
                        onChange={(event) => setNoteDraft(event.target.value)}
                      />
                      <button type="button" disabled={savingNote || !noteDraft.trim()} onClick={() => void submitNote()}>
                        {savingNote ? 'Saving…' : 'Add note'}
                      </button>
                    </div>
                  )}
                </div>
              </Card>
            </>
          )}
        </div>
      </div>

      {importing && <CustomerImportDialog onClose={()=>setImporting(false)} onImported={()=>{setImporting(false);setOffset(0);void loadList();}} />}
      {showCreate && (
        <CreateCustomerDialog
          onClose={() => setShowCreate(false)}
          onCreated={(customer) => {
            setShowCreate(false);
            void loadList();
            selectCustomer(customer.id);
          }}
        />
      )}
    </>
  );
}

function CreateCustomerDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (customer: Customer) => void }) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState('');
  const [primaryPhone, setPrimaryPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if(busy) return;
    const form=new FormData(event.currentTarget as HTMLFormElement);
    setBusy(true);
    try {
      const customer = await customersApi.create({
        displayName: displayName.trim(),
        primaryPhone: primaryPhone.trim() || undefined,
        email: email.trim() || undefined,
        company: company.trim() || undefined,
        code: String(form.get('code') || '').trim() || undefined,
        ...customerBusinessFields(form),
      });
      onCreated(customer);
    } catch (failure) {
      toast.error(errorMessage(failure, 'The customer could not be created.'));
      setBusy(false);
    }
  }

  return (
    <Dialog title="New customer" onClose={()=>{if(!busy) onClose();}}>
      <form className="workspace-form" onSubmit={(event) => void submit(event)}>
        <div className="dialog-body stack">
          <Field label="Name">
            <input value={displayName} autoFocus required maxLength={190} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
          <Field label="Phone" hint="Optional. Digits only.">
            <input value={primaryPhone} maxLength={32} onChange={(event) => setPrimaryPhone(event.target.value)} />
          </Field>
          <Field label="Email" hint="Optional.">
            <input type="email" value={email} maxLength={255} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label="Company" hint="Optional.">
            <input value={company} maxLength={190} onChange={(event) => setCompany(event.target.value)} />
          </Field>
          <CustomerFields code />
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !displayName.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
