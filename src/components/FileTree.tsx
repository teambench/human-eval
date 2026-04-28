import { useState } from 'react';
import { FileEntry } from '../types';

interface FileTreeProps {
  files: FileEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  // Optional: paths that have been modified relative to some baseline
  // (e.g. the AI Executor edited them in hybrid mode). Rendered with a
  // bright name + amber dot so the Verifier can scan changes at a glance.
  modifiedPaths?: Set<string>;
  // When provided, render a "+ New file" affordance + per-row delete
  // buttons. Only writer roles (executor in team/hybrid, oracle in solo)
  // pass these — read-only roles (planner, verifier) leave them undefined
  // so the affordances don't appear at all.
  // onCreate returns the canonical path on success or null on rejection
  // (validation/protected zone) so we can also auto-select the new file.
  onCreate?: (path: string) => Promise<string | null>;
  onDelete?: (path: string) => Promise<boolean>;
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

export function FileTree({ files, selectedPath, onSelect, modifiedPaths, onCreate, onDelete }: FileTreeProps) {
  const [creating, setCreating] = useState(false);
  const [draftPath, setDraftPath] = useState('');
  const [busy, setBusy] = useState(false);

  const submitCreate = async () => {
    if (!onCreate || busy) return;
    const trimmed = draftPath.trim();
    if (!trimmed) { setCreating(false); return; }
    setBusy(true);
    const result = await onCreate(trimmed);
    setBusy(false);
    if (result) {
      // Auto-select the new file so Monaco focuses it.
      onSelect(result);
      setDraftPath('');
      setCreating(false);
    }
    // On failure (alert was shown by onCreate), keep the inline input open
    // so the participant can correct the path without retyping.
  };

  return (
    <div style={{ background: '#181825', height: '100%', overflowY: 'auto', padding: '8px 0' }}>
      <div style={{
        padding: '4px 12px', fontSize: 11, color: '#888', fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span>Files</span>
        {onCreate && (
          <button
            onClick={() => { setCreating(true); setDraftPath(''); }}
            title="Create a new file in the workspace"
            style={{
              background: 'transparent', color: '#a6adc8',
              border: '1px solid #45475a', borderRadius: 3,
              padding: '0 6px', fontSize: 11, cursor: 'pointer',
              lineHeight: '16px', fontWeight: 600,
            }}
          >
            + New file
          </button>
        )}
      </div>
      {creating && onCreate && (
        <div style={{ padding: '4px 12px', display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            autoFocus
            value={draftPath}
            disabled={busy}
            placeholder="e.g. tests/test_mathutils.py"
            onChange={e => setDraftPath(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') submitCreate();
              else if (e.key === 'Escape') { setCreating(false); setDraftPath(''); }
            }}
            style={{
              flex: 1, background: '#313244', color: '#cdd6f4',
              border: '1px solid #45475a', borderRadius: 3,
              padding: '3px 6px', fontSize: 12, outline: 'none',
              fontFamily: 'ui-monospace, monospace',
            }}
          />
          <button
            onClick={submitCreate}
            disabled={busy || !draftPath.trim()}
            title="Create file"
            style={{
              background: '#89b4fa', color: '#1e1e2e', border: 'none',
              borderRadius: 3, padding: '3px 8px', fontSize: 11,
              cursor: (busy || !draftPath.trim()) ? 'not-allowed' : 'pointer',
              fontWeight: 700,
            }}
          >
            {busy ? '…' : 'Add'}
          </button>
          <button
            onClick={() => { setCreating(false); setDraftPath(''); }}
            title="Cancel"
            style={{
              background: 'transparent', color: '#888',
              border: '1px solid #45475a', borderRadius: 3,
              padding: '3px 6px', fontSize: 11, cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
      )}
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
                title="Modified by the Executor"
                style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: '#fbbf24', flexShrink: 0,
                }}
              />
            )}
            {f.readOnly && (
              <span style={{ fontSize: 9, color: '#f38ba8', opacity: 0.7 }}>RO</span>
            )}
            {onDelete && !f.readOnly && (
              <button
                onClick={async (e) => {
                  // Don't let the row's onClick fire; we'd open the file
                  // we're about to delete.
                  e.stopPropagation();
                  if (!window.confirm(`Delete ${f.path}? This can't be undone.`)) return;
                  await onDelete(f.path);
                }}
                title={`Delete ${f.path}`}
                style={{
                  background: 'transparent', color: '#6c7086',
                  border: 'none', cursor: 'pointer', fontSize: 12,
                  padding: '0 4px', lineHeight: 1,
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
