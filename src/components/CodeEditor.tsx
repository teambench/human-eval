import Editor from '@monaco-editor/react';

interface CodeEditorProps {
  content: string;
  language: string;
  readOnly: boolean;
  onChange?: (value: string) => void;
}

export function CodeEditor({ content, language, readOnly, onChange }: CodeEditorProps) {
  return (
    <Editor
      height="100%"
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
