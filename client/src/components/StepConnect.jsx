import { useState } from 'react';

export default function StepConnect({ onDone }) {
  const [skyLeadApiKey, setSkyLeadApiKey] = useState('');
  const [salesrobotApiKey, setSalesrobotApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleConnect() {
    setError('');
    setLoading(true);
    try {
      const resp = await fetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skyLeadApiKey, salesrobotApiKey }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Connection failed');
      onDone({
        creds: { skyLeadApiKey, skyLeadUserId: String(data.userId), salesrobotApiKey },
        skyLeadUser: data.skyLeadUser,
        seats: data.seats,
        srAccounts: data.srAccounts,
        srEmailAccounts: data.srEmailAccounts || [],
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const ready = skyLeadApiKey && salesrobotApiKey;

  return (
    <div className="card">
      <h2>Connect your accounts</h2>
      <p className="subtitle">Enter your API keys — they are only used for this session and never stored.</p>

      {error && <div className="error-box">{error}</div>}

      <div className="form-group">
        <label>Skylead API Key</label>
        <input
          type="password"
          placeholder="Paste your Skylead API key"
          value={skyLeadApiKey}
          onChange={e => setSkyLeadApiKey(e.target.value)}
        />
        <p className="hint">Found in Skylead → Settings → API</p>
      </div>

      <div className="form-group">
        <label>Salesrobot API Key</label>
        <input
          type="password"
          placeholder="Paste your Salesrobot API key"
          value={salesrobotApiKey}
          onChange={e => setSalesrobotApiKey(e.target.value)}
        />
        <p className="hint">Found in Salesrobot → Settings → API Key</p>
      </div>

      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" disabled={!ready || loading} onClick={handleConnect}>
          {loading ? <><span className="spinner" /> Connecting...</> : 'Connect →'}
        </button>
      </div>
    </div>
  );
}
