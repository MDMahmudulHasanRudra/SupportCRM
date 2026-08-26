import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  customers as customersApi,
  type Customer,
  type CustomerIdentity,
  type CustomerNote,
  type CustomerWithTags,
} from '../api/client';
import { useAuth } from '../auth-context';
import {
  Badge,
  Card,
  Empty,
  ErrorState,
  Field,
  Loading,
  PageHeader,
  RelativeTime,
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

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerWithTags | null>(null);
  const [identities, setIdentities] = useState<CustomerIdentity[] | null>(null);
  const [notes, setNotes] = useState<CustomerNote[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const { items: rows } = await customersApi.list({ search: search || undefined, limit: 50 });
      setItems(rows);
      setListError(null);
    } catch (failure) {
      setListError(errorMessage(failure, 'Customers could not be loaded.'));
    }
  }, [search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(), 250);
    return () => window.clearTimeout(timer);
  }, [loadList]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const [customer, identityPage, notePage] = await Promise.all([
        customersApi.get(id),
        customersApi.identities(id),
        customersApi.notes(id),
      ]);
      setDetail(customer);
      setIdentities(identityPage.items);
      setNotes(notePage.items);
      setDetailError(null);
    } catch (failure) {
      setDetailError(errorMessage(failure, 'This customer could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  async function submitNote() {
    if (!selectedId || !noteDraft.trim()) return;
    setSavingNote(true);
    try {
      await customersApi.addNote(selectedId, noteDraft.trim());
      setNoteDraft('');
      await loadDetail(selectedId);
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
        actions={
          canManage && (
            <button type="button" className="primary" onClick={() => setShowCreate(true)}>
              + New customer
            </button>
          )
        }
      />

      <div className="customers-shell">
        <div className="inbox-pane" style={{ height: 'calc(100vh - 160px)', minHeight: 420 }}>
          <div className="inbox-search">
            <input placeholder="Search name, phone, email…" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div className="inbox-list">
            {listError && (
              <div style={{ padding: 14 }}>
                <ErrorState message={listError} onRetry={() => void loadList()} />
              </div>
            )}
            {!items && !listError && (
              <div style={{ padding: 14 }}>
                <Loading label="Loading customers…" />
              </div>
            )}
            {items && items.length === 0 && <Empty title="No customers" hint="Nothing matches this search yet." />}
            {items?.map((customer) => (
              <button
                key={customer.id}
                type="button"
                className={customer.id === selectedId ? 'customer-row active' : 'customer-row'}
                onClick={() => setSelectedId(customer.id)}
              >
                <div className="customer-row-name">{customer.displayName}</div>
                <div className="customer-row-meta">{customer.primaryPhone ?? customer.email ?? customer.company ?? '—'}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="stack">
          {!selectedId && (
            <Card>
              <Empty title="Select a customer" hint="Pick one from the list to see their identities, notes and tags." />
            </Card>
          )}
          {selectedId && detailError && <ErrorState message={detailError} onRetry={() => void loadDetail(selectedId)} />}
          {selectedId && !detail && !detailError && (
            <Card>
              <Loading label="Loading…" />
            </Card>
          )}

          {detail && (
            <>
              <Card
                title={detail.displayName}
                actions={<Badge tone={detail.status === 'ACTIVE' ? 'ok' : 'neutral'}>{humanise(detail.status)}</Badge>}
              >
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
                      <div style={{ whiteSpace: 'pre-wrap' }}>{note.body}</div>
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

      {showCreate && (
        <CreateCustomerDialog
          onClose={() => setShowCreate(false)}
          onCreated={(customer) => {
            setShowCreate(false);
            void loadList();
            setSelectedId(customer.id);
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
    setBusy(true);
    try {
      const customer = await customersApi.create({
        displayName: displayName.trim(),
        primaryPhone: primaryPhone.trim() || undefined,
        email: email.trim() || undefined,
        company: company.trim() || undefined,
      });
      onCreated(customer);
    } catch (failure) {
      toast.error(errorMessage(failure, 'The customer could not be created.'));
      setBusy(false);
    }
  }

  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-label="New customer">
      <form className="dialog" onSubmit={(event) => void submit(event)}>
        <div className="dialog-head">
          <h2>New customer</h2>
        </div>
        <div className="dialog-body stack">
          <Field label="Name">
            <input value={displayName} autoFocus required onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
          <Field label="Phone" hint="Optional. Digits only.">
            <input value={primaryPhone} onChange={(event) => setPrimaryPhone(event.target.value)} />
          </Field>
          <Field label="Email" hint="Optional.">
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label="Company" hint="Optional.">
            <input value={company} onChange={(event) => setCompany(event.target.value)} />
          </Field>
        </div>
        <div className="dialog-foot">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !displayName.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
