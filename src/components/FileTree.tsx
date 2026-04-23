import { FileEntry } from '../types';

interface FileTreeProps {
  files: FileEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  // Optional: paths that have been modified relative to some baseline
  // (e.g. the AI Executor edited them in hybrid mode). Rendered with a
  // bright name + amber dot so the Verifier can scan changes at a glance.
  modifiedPaths?: Set<string>;
}

const EXT_ICONS: Record<string, string> = {
  py: 'PY',
  ts: 'TS',
  js: 'JS',
  md: 'MD',
  json: 'JS',
  yaml: 'YM',
  sh: 'SH',
};

export function FileTree({ files, selectedPath, onSelect, modifiedPaths }: FileTreeProps) {
  return (
    <div style={{ background: '#181825', height: '100%', overflowY: 'auto', padding: '8px 0' }}>
      <div style={{ padding: '4px 12px', fontSize: 11, color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
        Files
      </div>
      {files.map(f => {
        const ext = f.path.split('.').pop() ?? '';
        const isSelected = f.path === selectedPath;
        const isModified = modifiedPaths?.has(f.path) === true;
        return (
          <div
            key={f.path}
            onClick={() => onSelect(f.path)}
            style={{
              padding: '5px 12px',
              cursor: 'pointer',
              background: isSelected ? '#313244' : 'transparent',
              color: isSelected ? '#cdd6f4' : isModified ? '#fbbf24' : '#a6adc8',
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              borderLeft: isSelected ? '2px solid #89b4fa'
                : isModified ? '2px solid rgba(251,191,36,0.6)'
                : '2px solid transparent',
              fontWeight: isModified ? 600 : 400,
            }}
          >
            <span style={{
              fontSize: 9, fontWeight: 700, color: '#89b4fa', background: '#313244',
              padding: '1px 4px', borderRadius: 3, minWidth: 18, textAlign: 'center',
            }}>
              {EXT_ICONS[ext] ?? ext.toUpperCase().slice(0, 2)}
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {f.path}
            </span>
            {isModified && (
              <span
                title="Modified by AI Executor"
                style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: '#fbbf24', flexShrink: 0,
                }}
              />
            )}
            {f.readOnly && (
              <span style={{ fontSize: 9, color: '#f38ba8', opacity: 0.7 }}>RO</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
