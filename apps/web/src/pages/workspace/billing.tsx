import { useCallback, useState, type FormEvent } from 'react';
import { customers, type Customer } from '../../api/client';
import { currencyDigits, money, shortDate, toMinor, workspace, type Invoice, type Payment, type Subscription } from '../../api/workspace';
import { useAuth } from '../../auth-context';
import { Badge, Card, Empty, ErrorState, Loading, PageHeader, TableWrap, errorMessage, useToast } from '../../components/ui';
import { Dialog, downloadCsv, useResource } from './shared';

type Modal = { kind: 'invoice' | 'subscription' } | { kind: 'payment'; invoice: Invoice } | { kind: 'reverse'; payment: Payment } | { kind: 'renew'; subscription: Subscription };
export function BillingPage() {
  const { can } = useAuth(); const toast = useToast();
  const { data, busy, error, refresh } = useResource(workspace.billing);
  const [tab, setTab] = useState('invoices'); const [search, setSearch] = useState('');
  const [modal, setModal] = useState<Modal | null>(null); const [saving, setSaving] = useState(false);
  const [people, setPeople] = useState<Customer[]>([]); const [formError, setFormError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[] | null>(null);
  const [paymentKey, setPaymentKey] = useState('');
  const open = useCallback(async (next: Modal) => {
    setFormError(null); setModal(next); setPaymentKey(crypto.randomUUID());
    if (next.kind === 'invoice' || next.kind === 'subscription') {
      try { setPeople((await customers.list({ limit: 100 })).items); } catch (e) { setFormError(errorMessage(e, 'Could not load customers.')); }
    }
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!modal || saving) return; setSaving(true); setFormError(null);
    const f = new FormData(event.currentTarget); const get = (key: string) => String(f.get(key) ?? '');
    try {
      if (modal.kind === 'invoice') await workspace.invoice({ customerId: get('customerId'), description: get('description'), currency: get('currency'), amountMinor: toMinor(get('amount'), get('currency')), dueDate: get('dueDate') });
      if (modal.kind === 'payment') await workspace.pay({ invoiceId: modal.invoice.id, amountMinor: toMinor(get('amount'), modal.invoice.currency), reference: get('reference'), idempotencyKey: paymentKey });
      if (modal.kind === 'reverse') await workspace.reverse(modal.payment.id, get('reason'));
      if (modal.kind === 'subscription') await workspace.subscribe({ customerId: get('customerId'), name: get('name'), status: get('status'), startsOn: get('startsOn'), endsOn: get('endsOn') });
      if (modal.kind === 'renew') await workspace.subscriptionAction(modal.subscription.id, 'RENEW', get('endsOn'));
      setModal(null); toast.success('Billing record saved.'); await refresh();
    } catch (e) { setFormError(errorMessage(e, 'Could not save the billing record.')); } finally { setSaving(false); }
  }
  async function action(s: Subscription, action: string) {
    if (saving) return; setSaving(true);
    try { await workspace.subscriptionAction(s.id, action); toast.success('Subscription updated.'); await refresh(); }
    catch (e) { toast.error(errorMessage(e, 'Could not update the subscription.')); } finally { setSaving(false); }
  }
  const match = (value: string) => value.toLowerCase().includes(search.toLowerCase());
  return <>
    <PageHeader title="Billing & subscriptions" description="A clear view of every term, invoice and payment." actions={can('billing.manage') && can('customers.read') && <><button onClick={() => void open({ kind: 'subscription' })}>+ Subscription</button><button className="primary" onClick={() => void open({ kind: 'invoice' })}>+ Create invoice</button></>} />
    {error && <ErrorState message={error} onRetry={() => void refresh()} />}
    {busy && !data ? <Loading /> : data && <>
      <div className="billing-totals">{data.totals.length ? data.totals.map(t => <div className="overview-stat" key={t.currency}><div className="overview-stat-top"><span>Outstanding balance</span><Badge>{t.currency}</Badge></div><strong>{money(t.balanceMinor, t.currency)}</strong><span className="small muted">{money(t.paidMinor, t.currency)} paid · {money(t.invoicedMinor, t.currency)} invoiced</span></div>) : <div className="workspace-tip">Create your first invoice to start tracking balances. Each currency is reported separately.</div>}</div>
      <div className="workspace-toolbar"><div className="workspace-tabs" role="tablist" aria-label="Billing views">{['invoices', 'payments', 'subscriptions'].map(t => <button role="tab" aria-selected={tab === t} key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)} <span>{data[t as 'invoices' | 'payments' | 'subscriptions'].length}</span></button>)}</div><input aria-label="Search billing records" placeholder="Search customer or record…" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <Card title={tab === 'invoices' ? 'Invoices' : tab === 'payments' ? 'Payment receipts' : 'Client subscriptions'} actions={can('reports.export') && <button onClick={() => downloadCsv(`billing-${tab}.csv`, data[tab as 'invoices' | 'payments' | 'subscriptions'].map(r => ({ ...r })))}>Export CSV</button>}>
        <TableWrap><table><thead>{tab === 'invoices' ? <tr><th>Invoice / customer</th><th>Description</th><th>Amount</th><th>Outstanding</th><th>Due date</th><th>Status</th><th /></tr> : tab === 'payments' ? <tr><th>Receipt / customer</th><th>Invoice</th><th>Amount</th><th>Reference</th><th>Received</th><th>Status</th><th /></tr> : <tr><th>Customer</th><th>Subscription</th><th>Term</th><th>Status</th><th>Actions</th></tr>}</thead><tbody>
          {tab === 'invoices' && data.invoices.filter(i => match(`${i.number} ${i.customerName} ${i.description}`)).map(i => <tr key={i.id}><td><strong>{i.number}</strong><div className="small muted">{i.customerName}</div></td><td>{i.description}</td><td className="nowrap">{money(i.amountMinor, i.currency)}</td><td className="nowrap">{money(i.balanceMinor, i.currency)}</td><td className="nowrap">{shortDate(i.dueDate)}</td><td><Badge tone={i.status === 'PAID' ? 'ok' : i.status === 'OVERDUE' ? 'bad' : 'warn'}>{i.status}</Badge></td><td>{can('billing.manage') && Number(i.balanceMinor) > 0 && <button onClick={() => void open({ kind: 'payment', invoice: i })}>Record payment</button>}</td></tr>)}
          {tab === 'payments' && data.payments.filter(p => match(`${p.customerName} ${p.reference} ${p.number}`)).map(p => <tr key={p.id}><td><strong>RCT-{p.id.slice(0, 8).toUpperCase()}</strong><div className="small muted">{p.customerName}</div></td><td>{p.number}</td><td className="nowrap">{money(p.amountMinor, p.currency)}</td><td>{p.reference}</td><td className="nowrap">{shortDate(p.createdAt)}</td><td><Badge tone={p.reversedAt ? 'bad' : 'ok'}>{p.reversedAt ? 'Reversed' : 'Recorded'}</Badge>{p.reversalReason && <div className="small muted">{p.reversalReason}</div>}</td><td>{can('billing.manage') && !p.reversedAt && <button onClick={() => void open({ kind: 'reverse', payment: p })}>Reverse</button>}</td></tr>)}
          {tab === 'subscriptions' && data.subscriptions.filter(s => match(`${s.customerName} ${s.name}`)).map(s => <tr key={s.id}><td><strong>{s.customerName}</strong></td><td>{s.name}</td><td className="nowrap">{shortDate(s.startsOn)} – {shortDate(s.endsOn)}</td><td><Badge tone={s.displayStatus === 'ACTIVE' ? 'ok' : s.displayStatus === 'EXPIRED' ? 'bad' : 'neutral'}>{s.displayStatus}</Badge></td><td><div className="row">{can('billing.manage') && s.status !== 'CANCELLED' && <><button disabled={saving} onClick={() => void open({ kind: 'renew', subscription: s })}>Renew</button><button disabled={saving} onClick={() => void action(s, s.status === 'PAUSED' ? 'RESUME' : 'PAUSE')}>{s.status === 'PAUSED' ? 'Resume' : 'Pause'}</button><button disabled={saving} onClick={() => { if (window.confirm(`Cancel ${s.name} for ${s.customerName}?`)) void action(s, 'CANCEL'); }}>Cancel</button></>}<button onClick={() => void workspace.subscriptionHistory(s.id).then(p => setHistory(p.items.map(h => `${shortDate(h.createdAt)} · ${h.action}`))).catch(e => toast.error(errorMessage(e, 'Could not load history.')))}>History</button></div></td></tr>)}
        </tbody></table></TableWrap>
        {data[tab as 'invoices' | 'payments' | 'subscriptions'].length === 0 && <Empty title={`No ${tab} yet`} hint="New records will appear here." />}
        <p className="small muted">Showing the latest 200 records in each view. Payments are recorded here; no money is charged.</p>
      </Card>
    </>}
    {modal && <Dialog title={modal.kind === 'invoice' ? 'Create invoice' : modal.kind === 'payment' ? `Record payment · ${modal.invoice.number}` : modal.kind === 'reverse' ? 'Reverse payment' : modal.kind === 'renew' ? 'Renew subscription' : 'New subscription'} onClose={() => { if (!saving) setModal(null); }}><form className="workspace-form" onSubmit={e => void submit(e)}>
      {formError && <div role="alert" className="alert">{formError}</div>}
      {(modal.kind === 'invoice' || modal.kind === 'subscription') && <label>Customer<select name="customerId" required defaultValue=""><option value="" disabled>Select customer</option>{people.map(c => <option key={c.id} value={c.id}>{c.displayName}</option>)}</select><small className="muted">First 100 customers. Create a customer in the directory if needed.</small></label>}
      {modal.kind === 'invoice' && <><label>Description<input name="description" required maxLength={500} placeholder="Monthly support service" /></label><div className="form-columns"><label>Amount<input name="amount" inputMode="decimal" required placeholder="0.00" /></label><label>Currency<select name="currency" defaultValue="BDT">{['BDT','USD','EUR','GBP','INR','JPY','KWD'].map(c => <option key={c}>{c}</option>)}</select></label></div><label>Due date<input type="date" name="dueDate" required /></label></>}
      {modal.kind === 'payment' && <><p className="muted">Outstanding: <strong>{money(modal.invoice.balanceMinor, modal.invoice.currency)}</strong></p><label>Amount ({modal.invoice.currency})<input name="amount" inputMode="decimal" required defaultValue={(Number(modal.invoice.balanceMinor) / 10 ** currencyDigits(modal.invoice.currency)).toFixed(currencyDigits(modal.invoice.currency))} /></label><label>Reference / payment method<input name="reference" required maxLength={190} placeholder="Bank transfer reference, cash, or receipt number" /></label></>}
      {modal.kind === 'reverse' && <><p>Reverse {money(modal.payment.amountMinor, modal.payment.currency)}? The receipt remains in history and the invoice balance will increase.</p><label>Reason<textarea name="reason" required maxLength={500} rows={3} /></label></>}
      {modal.kind === 'subscription' && <><label>Plan / service<input name="name" required maxLength={160} /></label><label>Starting status<select name="status"><option value="ACTIVE">Active</option><option value="TRIAL">Trial / demo</option></select></label><div className="form-columns"><label>Starts on<input type="date" name="startsOn" required /></label><label>Ends on<input type="date" name="endsOn" required /></label></div></>}
      {modal.kind === 'renew' && <><p className="muted">Current term ends {shortDate(modal.subscription.endsOn)}.</p><label>New end date<input type="date" name="endsOn" required min={modal.subscription.endsOn.slice(0, 10)} /></label></>}
      <div className="dialog-actions"><button type="button" disabled={saving} onClick={() => setModal(null)}>Cancel</button><button type="submit" className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save record'}</button></div>
    </form></Dialog>}
    {history && <Dialog title="Subscription history" onClose={() => setHistory(null)}><div className="stack">{history.map((h,i) => <div key={i} className="workspace-history-row">{h}</div>)}</div></Dialog>}
  </>;
}
