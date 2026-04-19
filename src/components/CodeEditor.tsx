import { useCallback, useRef } from 'react';
import Editor from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';

interface CodeEditorProps {
  path: string;
  content: string;
  language: string;
  readOnly: boolean;
  onChange?: (value: string) => void;
}

/**
 * Monaco wrapper hardened against cross-file content corruption on
 * fast file switches.
 *
 * The @monaco-editor/react wrapper has a listener-recreation race:
 *   1. On every render it re-computes the subscribe effect as
 *      `useEffect(() => { if (s && O) { dispose(); attach(listener) } }, [s, O])`
 *   2. The RO branch of its value-sync effect calls `editor.setValue(t)`
 *      UNGUARDED by the internal programmatic-update flag.
 *   3. When the parent switches from an editable file (onChange=fn_A) to
 *      a RO file (onChange=undefined), effects run in declaration order:
 *      [m] setModel → [x] options → [t] setValue → [s,O] listener rebind.
 *   4. During step [t], the stale listener (still holding fn_A) fires
 *      for the new model's flush event, writing the *new* file's content
 *      under the *old* file's path.
 *   5. React batching during fast click switches makes this more likely.
 *
 * Fix, layered:
 *   A. Pass `path` so Monaco keeps per-file models (prevents model reuse).
 *   B. Pass a STABLE onChange (useCallback with [] deps). Since the prop
 *      identity never changes, the wrapper's [s,O] effect sees O constant
 *      and never recreates the listener. The listener captures the stable
 *      function once, and that function reads from `onChangeRef.current`
 *      which is updated synchronously during render. No stale closure.
 *   C. Filter `event.isFlush` inside the stable handler. Monaco tags
 *      every programmatic setValue with isFlush=true; real user edits
 *      have isFlush=false. So even if the RO-branch setValue fires during
 *      a file switch, our handler sees isFlush=true and returns before
 *      calling onChange. No cross-file writes possible.
 */
export function CodeEditor({ path, content, language, readOnly, onChange }: CodeEditorProps) {
  const onChangeRef = useRef(onChange);
  // Synchronously update during render so the stable handler below always
  // dispatches to the LATEST onChange, without triggering Monaco wrapper
  // listener re-creation.
  onChangeRef.current = onChange;

  const stableOnChange = useCallback(
    (value: string | undefined, event: MonacoEditor.IModelContentChangedEvent) => {
      if (event?.isFlush) return; // programmatic setValue — not a user edit
      onChangeRef.current?.(value ?? '');
    },
    [],
  );

  return (
    <Editor
      height="100%"
      path={path}
      language={language}
      value={content}
      theme="vs-dark"
      onChange={stableOnChange}
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
