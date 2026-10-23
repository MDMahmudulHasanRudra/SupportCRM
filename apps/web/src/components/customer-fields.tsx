import { useEffect, useState } from 'react';
import { customers, type Customer } from '../api/client';
import { errorMessage } from './ui';

export function CustomerFields({ customer, code = false }: { customer?: Customer; code?: boolean }) {
  const [owners, setOwners] = useState<Array<{id:string;name:string;username:string}>>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => { let active = true; void customers.owners().then(p => { if (active) { setOwners(p.items); setError(null); } }).catch(e => { if(active) setError(errorMessage(e,'Could not load account owners.')); }); return () => { active=false; }; },[version]);
  return <>
    {code && <label>Client code<input name="code" maxLength={40} pattern="[A-Z0-9][A-Z0-9_-]{1,39}" placeholder="Automatic if empty" /><small className="muted">Optional custom code. CL-number codes are reserved for automatic numbering. Codes stay fixed after creation.</small></label>}
    <div className="form-columns"><label>Country code<input name="country" maxLength={2} minLength={2} pattern="[A-Za-z]{2}" defaultValue={customer?.country || ''} placeholder="BD" autoComplete="country" /><small className="muted">Two-letter ISO code, for example BD, IN or US.</small></label><label>Service / product<input name="serviceName" maxLength={160} defaultValue={customer?.serviceName || ''} placeholder="Support plan" /></label></div>
    <label>Account owner<select name="accountOwnerId" defaultValue={customer?.accountOwnerId || ''}><option value="">Unassigned</option>{customer?.accountOwnerId && !owners.some(o => o.id === customer.accountOwnerId) && <option value={customer.accountOwnerId}>{customer.accountOwner?.name || 'Current owner'} (retained)</option>}{owners.map(o => <option value={o.id} key={o.id}>{o.name} (@{o.username})</option>)}</select></label>
    {error && <div className="alert" role="alert">{error} <button type="button" onClick={() => setVersion(v=>v+1)}>Retry owner list</button></div>}
  </>;
}

export function customerBusinessFields(form: FormData) {
  return { country: String(form.get('country') || '').trim().toUpperCase() || null, serviceName: String(form.get('serviceName') || '').trim() || null, accountOwnerId: String(form.get('accountOwnerId') || '') || null };
}
