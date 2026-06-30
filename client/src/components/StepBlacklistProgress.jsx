import { useState, useEffect, useRef } from 'react';

export default function StepBlacklistProgress({ credentials, accountMappings, skyleadCookie, appBaseUrl, onDone }) {
  const [logs, setLogs] = useState([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef(null);
  const doneRef = useRef(false);

  useEffect(() => {
    startImport();
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  function addLog(message, type = 'log') {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, { message, type, time, id: Date.now() + Math.random() }]);
  }

  function handleEvent(event) {
    switch (event.type) {
      case 'log':
        addLog(event.message, 'log');
        break;
      case 'account_start':
        addLog(`▶ Seat ${event.seat}`, 'campaign');
        break;
      case 'account_done':
        addLog(`✓ Seat ${event.seat} done`, 'done');
        break;
      case 'error':
        addLog(`ERROR: ${event.message}`, 'error');
        break;
      case 'complete':
        addLog('Blacklist import complete!', 'done');
        doneRef.current = true;
        setDone(true);
        setTimeout(() => onDone(event.summary), 800);
        break;
      default:
        break;
    }
  }

  async function startImport() {
    try {
      const resp = await fetch('/api/blacklist/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...credentials, accountMappings, skyleadCookie, appBaseUrl }),
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

        const parts = buffer.split('\n\n');
        buffer = parts.pop();

        for (const part of parts) {
          const line = part.trim();
          if (!line || line.startsWith(':')) continue;
          if (line.startsWith('data: ')) {
            try {
              handleEvent(JSON.parse(line.slice(6)));
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
      <h2>{done ? 'Blacklist import complete' : 'Importing blacklist…'}</h2>
      <p className="subtitle">
        {done
          ? 'Your blacklist has been imported into Salesrobot. Redirecting to summary…'
          : 'Do not close this window while the import is in progress.'}
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="log-container" ref={logRef}>
        {logs.map(l => (
          <div key={l.id} className={`log-line ${l.type}`}>
            <span className="log-time">{l.time}</span> {l.message}
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
