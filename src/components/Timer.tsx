import { useState, useEffect } from 'react';

interface TimerProps {
  startTime: number | null;
  timeLimit: number; // seconds
}

export function Timer({ startTime, timeLimit }: TimerProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!startTime) {
    return <span style={{ color: '#888', fontSize: 13 }}>Not started</span>;
  }

  const elapsed = Math.floor((now - startTime) / 1000);
  const remaining = Math.max(0, timeLimit - elapsed);
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
