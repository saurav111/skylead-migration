import { useState } from 'react';

const DEFAULT_APP_URL = 'https://app.expertleads.io';

export default function StepBlacklistConnect({ initialCookie = '', initialAppUrl = DEFAULT_APP_URL, onDone }) {
  const [cookie, setCookie] = useState(initialCookie);
  const [appUrl, setAppUrl] = useState(initialAppUrl);

  const ready = cookie.trim() && appUrl.trim();

  return (
    <div className="card">
      <h2>Connect to your blacklist</h2>
      <p className="subtitle">
        Your blacklist lives behind the Skylead web app (not the public API), so it needs your
        logged-in session cookie to read it. This is only used for this session and never stored.
      </p>

      <div className="form-group">
        <label>Skylead app URL</label>
        <input
          type="text"
          placeholder={DEFAULT_APP_URL}
          value={appUrl}
          onChange={e => setAppUrl(e.target.value)}
        />
        <p className="hint">The domain you use to log in to Skylead (e.g. {DEFAULT_APP_URL}).</p>
      </div>

      <div className="form-group">
        <label>Session cookie</label>
        <textarea
          placeholder="Paste your session cookie here"
          value={cookie}
          onChange={e => setCookie(e.target.value)}
          rows={4}
          style={{ width: '100%', padding: '10px 14px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, fontFamily: 'Menlo, Monaco, monospace', outline: 'none', resize: 'vertical' }}
        />
        <p className="hint">
          In Skylead, open the Blacklist page → open browser DevTools → <strong>Network</strong> tab →
          click any request → copy the <code>cookie</code> request header and paste it here. The
          session cookie (e.g. <code>PpJzSRa7Rj=…</code>) is enough.
        </p>
      </div>

      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" disabled={!ready} onClick={() => onDone({ cookie: cookie.trim(), appUrl: appUrl.trim() })}>
          Continue →
        </button>
      </div>
    </div>
  );
}
