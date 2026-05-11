import { useState, useEffect, useRef } from 'react';

export default function StepProgress({ credentials, accountMappings, selectedCampaignIds, onDone }) {
  const [logs, setLogs] = useState([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef(null);

  useEffect(() => {
    startMigration();
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  async function startMigration() {
    // 1. Create session
    const resp = await fetch('/api/migrate/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...credentials,
        accountMappings,
        selectedCampaignIds,
      }),
    });

    const { sessionId, error: startError } = await resp.json();
    if (startError) {
      setError(startError);
      return;
    }

    // 2. Stream SSE
    const es = new EventSource(`/api/migrate/stream?sessionId=${sessionId}`);

    es.onmessage = (e) => {
      const event = JSON.parse(e.data);

      switch (event.type) {
        case 'log':
          addLog(event.message, 'log');
          break;
        case 'campaign_start':
          addLog(`▶ Migrating: ${event.name}`, 'campaign');
          break;
        case 'campaign_done':
          addLog(`✓ Done: ${event.name}`, 'done');
          break;
        case 'campaign_error':
          addLog(`✗ Failed: ${event.name} — ${event.message}`, 'error');
          break;
        case 'leads_imported':
          addLog(`  ↳ ${event.count} lead(s) imported at step ${event.step}`, 'log');
          break;
        case 'error':
          addLog(`ERROR: ${event.message}`, 'error');
          break;
        case 'complete':
          addLog('Migration complete!', 'done');
          setDone(true);
          es.close();
          setTimeout(() => onDone(event.summary), 800);
          break;
        default:
          break;
      }
    };

    es.onerror = () => {
      if (!done) {
        addLog('Connection lost. Migration may still be running on the server.', 'error');
        setError('Connection lost');
        es.close();
      }
    };
  }

  function addLog(message, type = 'log') {
    setLogs(prev => [...prev, { message, type, id: Date.now() + Math.random() }]);
  }

  return (
    <div className="card">
      <h2>{done ? 'Migration complete' : 'Migrating…'}</h2>
      <p className="subtitle">
        {done
          ? 'All selected campaigns have been migrated. Redirecting to summary…'
          : 'Do not close this window while migration is in progress.'}
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="log-container" ref={logRef}>
        {logs.map(l => (
          <div key={l.id} className={`log-line ${l.type}`}>
            {l.message}
          </div>
        ))}
        {!done && (
          <div className="log-line" style={{ opacity: 0.4 }}>
            <span className="spinner" style={{ display: 'inline-block', marginRight: 8 }} />
            Working…
          </div>
        )}
      </div>
    </div>
  );
}
