import { useState } from 'react';
import StepAccountMapping from './StepAccountMapping';
import StepPauseProgress from './StepPauseProgress';
import StepPauseSummary from './StepPauseSummary';

const PAUSE_STEPS = ['Map Accounts', 'Pause', 'Done'];

export default function PausedProspectsTab({ credentials, seats, srAccounts }) {
  const [step, setStep] = useState(0);
  const [accountMappings, setAccountMappings] = useState([]);
  const [summary, setSummary] = useState(null);

  function reset() {
    setStep(0);
    setAccountMappings([]);
    setSummary(null);
  }

  return (
    <>
      <Stepper current={step} steps={PAUSE_STEPS} />

      {step === 0 && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#1e40af' }}>
          <strong>Note:</strong> This is only required for older campaigns. Newer campaigns already handle pausing prospects automatically during import, so you don't need to run this for them.
        </div>
      )}

      {step === 0 && (
        <StepAccountMapping
          seats={seats}
          srAccounts={srAccounts}
          nextLabel="Pause prospects →"
          onDone={(mappings) => {
            setAccountMappings(mappings);
            setStep(1);
          }}
        />
      )}

      {step === 1 && (
        <StepPauseProgress
          credentials={credentials}
          accountMappings={accountMappings}
          onDone={(s) => { setSummary(s); setStep(2); }}
        />
      )}

      {step === 2 && (
        <StepPauseSummary summary={summary} onReset={reset} />
      )}
    </>
  );
}

function Stepper({ current, steps }) {
  return (
    <div className="stepper">
      {steps.map((label, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
          <div className={`step-item ${i === current ? 'active' : i < current ? 'done' : ''}`}>
            <div className="step-num">
              {i < current ? '✓' : i + 1}
            </div>
            <span>{label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`step-connector ${i < current ? 'done' : ''}`} />
          )}
        </div>
      ))}
    </div>
  );
}
