import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth-context';
import { whatsappTools } from '../api/whatsapp-tools';
import { ErrorState, errorMessage } from '../components/ui';
import { WhatsAppResult } from './whatsapp-tools';
import { WhatsAppIcon } from '../components/whatsapp-icons';
export function WhatsAppSettingsPage({ accountId }: {
    accountId: string;
}) {
    const { can } = useAuth();
    const [integration, setIntegration] = useState<Awaited<ReturnType<typeof whatsappTools.integrationSetup>> | null>(null);
    const [phone, setPhone] = useState('');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [passkey, setPasskey] = useState<Record<string, unknown> | null>(null);
    const [assertion, setAssertion] = useState('');
    const [remove, setRemove] = useState('');
    async function run(work: () => Promise<unknown>) { if (busy)
        return; setBusy(true); setError(null); try {
        await work();
    }
    catch (e) {
        setError(errorMessage(e, 'The request could not be completed.'));
    }
    finally {
        setBusy(false);
    } }
    return <div className="wa-subpage wa-settings"><header className="wa-tool-intro"><WhatsAppIcon name="settings" size={35}/><div><h1>WhatsApp settings</h1><p>Manage your connected number and workspace.</p></div></header><div className="wa-settings-links">{[['accounts', 'account', 'Linked devices & QR'], ['replies', 'chat', 'Saved replies'], ['assignments', 'groups', 'Support assignments'], ['broadcasts', 'send', 'Broadcast campaigns'], ['events', 'clock', 'Account activity'],['labels','star','WhatsApp labels'], ['tools?tool=chatwootUpsertDeviceConfig', 'tools', 'Chatwoot integration'], ['tools?tool=userMyPrivacy', 'lock', 'Privacy information'], ['tools?tool=userChangePushName', 'account', 'Profile name & photo']].map(([path, icon, label]) => <Link key={path} to={`/whatsapp/${path}${path.includes('?') ? '&' : '?'}account=${accountId}`}><WhatsAppIcon name={icon}/><span>{label}</span><span>›</span></Link>)}</div>
 {can('channels.manage') && accountId && <><section className="wa-tool-form"><h2>Link with a phone number</h2><p>Open WhatsApp on your phone → Linked devices → Link a device → Link with phone number.</p><form onSubmit={e => { e.preventDefault(); void run(async () => setCode((await whatsappTools.phoneCode(accountId, phone)).code)); }}><label className="wa-field"><span>Phone number with country code</span><input inputMode="tel" autoComplete="tel" pattern="[1-9][0-9]{6,14}" required value={phone} onChange={e => { setPhone(e.target.value); setCode(''); }} placeholder="8801…"/></label><button className="wa-primary" disabled={busy}>Get pairing code</button></form>{code && <p className="wa-pair-code" role="status">{code}</p>}</section>
 <section className="wa-tool-form"><h2>Passkey pairing</h2><p>When WhatsApp requests a passkey, retrieve its challenge and submit the WebAuthn response from your passkey flow.</p><button disabled={busy} onClick={() => void run(async () => setPasskey(await whatsappTools.passkey(accountId, 'status')))}>Get pairing challenge</button>{passkey && <WhatsAppResult value={passkey}/>}<label className="wa-field"><span>WebAuthn assertion JSON</span><textarea rows={4} value={assertion} onChange={e => setAssertion(e.target.value)}/></label><div className="row"><button disabled={busy || !assertion.trim()} onClick={() => void run(async () => setPasskey(await whatsappTools.passkey(accountId, 'response', JSON.parse(assertion))))}>Submit response</button><button disabled={busy || !passkey} onClick={() => void run(async () => setPasskey(await whatsappTools.passkey(accountId, 'confirm')))}>Confirm pairing</button></div></section>
 <section className="wa-tool-form"><h2>Chatwoot callback</h2><p>Configure Chatwoot first, then use this callback and secret header for agent replies.</p><button disabled={busy} onClick={() => void run(async () => setIntegration(await whatsappTools.integrationSetup(accountId)))}>Reveal callback settings</button>{integration && <><label className="wa-field"><span>Webhook URL</span><input readOnly value={integration.callbackUrl}/></label><label className="wa-field"><span>{integration.authenticationHeader}</span><input readOnly type="password" value={integration.webhookSecret}/></label><button onClick={() => void run(() => navigator.clipboard.writeText(integration.webhookSecret))}>Copy webhook secret</button></>}</section>
 <section className="wa-tool-form"><h2>Remove linked device</h2><p>Unlinks this device and retains the CRM account, customers and conversation history. You will need to enable CRM ownership and scan again.</p><label className="wa-field"><span>Type REMOVE to confirm</span><input value={remove} onChange={e => setRemove(e.target.value)}/></label><button className="danger" disabled={busy || remove !== 'REMOVE'} onClick={() => void run(async () => { await whatsappTools.removeDevice(accountId, remove); setRemove(''); setCode(''); setPasskey(null); })}>Remove device</button></section></>}
 {error && <ErrorState message={error}/>}</div>;
}
