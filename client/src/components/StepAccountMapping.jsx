import { useState } from 'react';

export default function StepAccountMapping({ seats, srAccounts, onBack, onDone }) {
  const [mappings, setMappings] = useState(
    seats.map(seat => ({ skyLeadAccountId: String(seat.id), salesrobotLinkedinAccountUuid: '' }))
  );
  const [error, setError] = useState('');

  function setMapping(idx, uuid) {
    setMappings(prev => prev.map((m, i) => i === idx ? { ...m, salesrobotLinkedinAccountUuid: uuid } : m));
  }

  function handleNext() {
    const unmapped = mappings.filter(m => !m.salesrobotLinkedinAccountUuid);
    if (unmapped.length > 0) {
      setError(`Please map all ${unmapped.length} Skylead seat(s) to a Salesrobot LinkedIn account.`);
      return;
    }
    onDone(mappings);
  }

  return (
    <div className="card">
      <h2>Map LinkedIn accounts</h2>
      <p className="subtitle">
        Match each Skylead seat to the same LinkedIn account in Salesrobot.
        The LinkedIn account must already be connected in Salesrobot.
      </p>

      {error && <div className="error-box">{error}</div>}

      {seats.map((seat, i) => (
        <div className="mapping-row" key={seat.id}>
          <div>
            <div className="seat-name">{seat.name || seat.email || `Seat ${seat.id}`}</div>
            <div className="seat-sub">Skylead seat ID: {seat.id}</div>
          </div>
          <div className="mapping-arrow">→</div>
          <div>
            <select
              value={mappings[i]?.salesrobotLinkedinAccountUuid || ''}
              onChange={e => setMapping(i, e.target.value)}
            >
              <option value="">Select Salesrobot account…</option>
              {srAccounts.map(acc => {
                const health = acc.healthStatus === 'HEALTHY' ? '✓' : '⚠';
                const label = `${health} ${acc.nameOnLinkedinAccount || acc.emailId} (${acc.emailId})`;
                return (
                  <option key={acc.linkedinAccountUuid} value={acc.linkedinAccountUuid}>
                    {label}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      ))}

      <div className="btn-row">
        <button className="btn btn-secondary" onClick={onBack}>← Back</button>
        <button className="btn btn-primary" onClick={handleNext}>
          Next: Select campaigns →
        </button>
      </div>
    </div>
  );
}
