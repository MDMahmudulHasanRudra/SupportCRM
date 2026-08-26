import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth-context';

export function LoginPage() {
  const { signIn } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
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
    <div className="login">
      <form className="card card-pad stack" onSubmit={(event) => void submit(event)}>
        <div>
          <div className="login-brand">
            <span className="brand-mark">S</span>
            <h1>Support CRM</h1>
          </div>
          <p className="page-sub" style={{ margin: '4px 0 0' }}>
            Sign in to continue.
          </p>
        </div>

        {error && <div className="alert">{error}</div>}

        <div>
          <label htmlFor="identifier">Username or email</label>
          <input
            id="identifier"
            value={identifier}
            autoComplete="username"
            autoFocus
            required
            onChange={(event) => setIdentifier(event.target.value)}
          />
        </div>

        <div>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            autoComplete="current-password"
            required
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
