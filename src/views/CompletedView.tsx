interface CompletedViewProps {
  taskId: string;
  startTime: number | null;
  endTime: number | null;
  onExportLogs: () => void;
}

export function CompletedView({ taskId, startTime, endTime, onExportLogs }: CompletedViewProps) {
  const duration = startTime && endTime
    ? Math.floor((endTime - startTime) / 1000)
    : 0;
  const minutes = Math.floor(duration / 60);
  const seconds = duration % 60;

  return (
    <div style={{
      minHeight: '100vh', background: '#11111b', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ textAlign: 'center', maxWidth: 500, padding: 32 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>&#10003;</div>
        <h1 style={{ color: '#a6e3a1', fontSize: 28, fontWeight: 700, margin: '0 0 8px' }}>
          Task Complete
        </h1>
        <p style={{ color: '#a6adc8', fontSize: 15, marginBottom: 24 }}>
          {taskId} &mdash; completed in {minutes}m {seconds}s
        </p>
        <button
          onClick={onExportLogs}
          style={{
            background: '#89b4fa', color: '#000', border: 'none', borderRadius: 8,
            padding: '12px 32px', fontWeight: 700, fontSize: 15, cursor: 'pointer',
          }}
        >
          Download Session Logs (JSON)
        </button>
        <p style={{ color: '#585b70', fontSize: 12, marginTop: 16 }}>
          The JSON log contains all messages, file edits, commands, and timestamps
          for analysis. Please submit this file to the experiment coordinator.
        </p>
      </div>
    </div>
  );
}
