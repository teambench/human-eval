import { useState, useEffect, useRef } from 'react';

interface TimerProps {
  startTime: number | null;
  timeLimit: number; // seconds
  // Fires exactly once when the countdown crosses 0. Each role view wires
  // this to setPhase('completed') so the participant is force-routed into
  // the survey when the time-box expires. Guarded by a ref so re-renders
  // (e.g. parent state churn) can't fire it twice.
  onTimeUp?: () => void;
}

export function Timer({ startTime, timeLimit, onTimeUp }: TimerProps) {
  const [now, setNow] = useState(Date.now());
  const firedRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!startTime) {
    return <span style={{ color: '#888', fontSize: 13 }}>Not started</span>;
  }

  const elapsed = Math.floor((now - startTime) / 1000);
  const remaining = Math.max(0, timeLimit - elapsed);
  if (remaining === 0 && !firedRef.current && onTimeUp) {
    firedRef.current = true;
    // Defer to next tick so we don't call setState during render.
    setTimeout(onTimeUp, 0);
  }
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const isLow = remaining < 120;

  return (
    <span style={{
      fontFamily: 'monospace',
      fontSize: 16,
      fontWeight: 700,
      color: isLow ? '#f38ba8' : '#a6e3a1',
    }}>
      {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
    </span>
  );
}
