import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth-context';
import { Brand } from '../components/workspace-shell';
import { IconBookOpen, IconInbox, IconMessageCircle, IconUsers } from '../components/icons';

export function LoginPage() {
  const { signIn } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      await signIn(identifier, password);
    } catch (failure) {
      // The API deliberately does not say which half was wrong — that would let someone enumerate
      // usernames — so the message is shown as it comes.
      setError(failure instanceof Error ? failure.message : 'Sign in failed.');
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <aside className="login-story"><Brand subtitle /><div className="login-story-content"><span className="login-story-kicker">ONE CONNECTED WORKSPACE</span><h2>Great support starts<br />with <span>a little clarity.</span></h2><p>Bring your conversations, people and knowledge together. Give every customer the attention they deserve.</p><div className="login-feature"><span><IconInbox size={19} /></span><div><strong>Every conversation, in focus</strong><small>A shared inbox for your support team.</small></div></div><div className="login-feature"><span><IconUsers size={19} /></span><div><strong>People working better together</strong><small>Clear ownership and a connected team.</small></div></div><div className="login-feature"><span><IconBookOpen size={19} /></span><div><strong>Good answers, always close</strong><small>Your verified knowledge, ready to help.</small></div></div></div><div className="login-story-foot"><IconMessageCircle size={14} /> Made for meaningful conversations.</div></aside>
      <div className="login-form-region"><form className="login-form" onSubmit={(event) => void submit(event)}>
        <span className="login-form-icon"><IconMessageCircle size={24} /></span><h1>Welcome back</h1><p className="login-subtitle">Sign in to your Support CRM workspace.</p>
        {error && <div className="alert" role="alert">{error}</div>}
        <div className="login-form-field">
          <label htmlFor="identifier">Username or email</label>
          <input
            id="identifier"
            value={identifier}
            autoComplete="username"
            autoFocus
            required
            placeholder="you@company.com"
            onChange={(event) => setIdentifier(event.target.value)}
          />
        </div>

        <div className="login-form-field">
          <label htmlFor="password">Password</label>
          <div className="login-password">
          <input
            id="password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            autoComplete="current-password"
            required
            placeholder="Enter your password"
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword(v => !v)}>{showPassword ? 'Hide' : 'Show'}</button>
          </div>
        </div>

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in to workspace'}{!busy && <span aria-hidden="true">→</span>}
        </button>
        <p className="login-form-note">Use the account provided by your workspace administrator.</p>
      </form></div>
    </div>
  );
}
