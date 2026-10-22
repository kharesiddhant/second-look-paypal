'use client';
// Unstyled on purpose: functional skeleton for the owner to design over.
import { useState, type FormEvent } from 'react';

export default function Login() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const password = new FormData(e.currentTarget).get('password');
    const res = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
    if (res.ok) window.location.href = '/';
    else { setError((await res.json()).error); setBusy(false); }
  }

  return (
    <main>
      <h1>Second Look</h1>
      <form onSubmit={submit}>
        <label>Password <input name="password" type="password" required autoFocus /></label>{' '}
        <button type="submit" disabled={busy}>Sign in</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
