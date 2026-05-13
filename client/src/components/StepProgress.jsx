import { useState, useEffect, useRef } from 'react';

export default function StepProgress({ credentials, accountMappings, selectedCampaignIds, onDone }) {
  const [logs, setLogs] = useState([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef(null);
  const doneRef = useRef(false);

  useEffect(() => {
    startMigration();
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  function addLog(message, type = 'log') {
    setLogs(prev => [...prev, { message, type, id: Date.now() + Math.random() }]);
  }

  function handleEvent(event) {
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
        doneRef.current = true;
        setDone(true);
        setTimeout(() => onDone(event.summary), 800);
        break;
      default:
        break;
    }
  }

  async function startMigration() {
    try {
      const resp = await fetch('/api/migrate/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...credentials, accountMappings, selectedCampaignIds }),
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setError(data.error || `Server error ${resp.status}`);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE lines look like: "data: {...}\n\n"
        const parts = buffer.split('\n\n');
        buffer = parts.pop(); // keep incomplete last chunk

        for (const part of parts) {
          const line = part.trim();
          if (!line || line.startsWith(':')) continue; // heartbeat or empty
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              handleEvent(event);
            } catch {
              // ignore malformed line
            }
          }
        }
      }
    } catch (err) {
      if (!doneRef.current) {
        addLog(`Connection error: ${err.message}`, 'error');
        setError('Connection lost');
      }
    }
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
