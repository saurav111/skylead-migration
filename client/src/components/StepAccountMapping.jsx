import { useState } from 'react';

export default function StepAccountMapping({ seats, srAccounts, onBack, onDone, nextLabel = 'Next: Select campaigns →' }) {
  const [mappings, setMappings] = useState(
    seats.map(seat => ({ skyLeadAccountId: String(seat.id), salesrobotLinkedinAccountUuid: '' }))
  );
  const [error, setError] = useState('');

  function setMapping(idx, uuid) {
    setMappings(prev => prev.map((m, i) => i === idx ? { ...m, salesrobotLinkedinAccountUuid: uuid } : m));
  }

  function handleNext() {
    const mapped = mappings.filter(m => m.salesrobotLinkedinAccountUuid);
    if (mapped.length === 0) {
      setError('Map at least one Skylead seat to a Salesrobot account to continue.');
      return;
    }
    onDone(mapped);
  }

  return (
    <div className="card">
      <h2>Map LinkedIn accounts</h2>
      <p className="subtitle">
        Match Skylead seats to their LinkedIn account in Salesrobot. Unmapped seats will be skipped.
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

      <div className="btn-row" style={onBack ? undefined : { justifyContent: 'flex-end' }}>
        {onBack && <button className="btn btn-secondary" onClick={onBack}>← Back</button>}
        <button className="btn btn-primary" onClick={handleNext}>
          {nextLabel}
        </button>
      </div>
    </div>
  );
}
