import Editor from '@monaco-editor/react';

interface CodeEditorProps {
  path: string;
  content: string;
  language: string;
  readOnly: boolean;
  onChange?: (value: string) => void;
}

/**
 * Monaco wrapper.
 *
 * Uses `path` to give Monaco a per-file model. This avoids the cross-file
 * corruption bug where switching editable A → RO B → back to A overwrote
 * A's content with B's content: Monaco was reusing a single model, and
 * the onChange event fired during programmatic setValue calls picked up
 * stale closures. With `path`, Monaco keeps separate models per file,
 * only fires onChange for real user edits in the current model, and
 * restores each file's buffer when you switch back.
 */
export function CodeEditor({ path, content, language, readOnly, onChange }: CodeEditorProps) {
  return (
    <Editor
      height="100%"
      path={path}
      language={language}
      value={content}
      theme="vs-dark"
      onChange={v => onChange?.(v ?? '')}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        tabSize: 4,
        renderLineHighlight: readOnly ? 'none' : 'line',
        domReadOnly: readOnly,
      }}
    />
  );
}
