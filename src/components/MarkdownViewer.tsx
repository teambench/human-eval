import ReactMarkdown from 'react-markdown';

interface MarkdownViewerProps {
  content: string;
  title?: string;
}

export function MarkdownViewer({ content, title }: MarkdownViewerProps) {
  return (
    <div style={{
      background: '#1e1e2e',
      color: '#cdd6f4',
      padding: 16,
      borderRadius: 8,
      overflowY: 'auto',
      height: '100%',
    }}>
      {title && (
        <div style={{
          fontSize: 11, color: '#888', fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: 1, marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid #333',
        }}>
          {title}
        </div>
      )}
      <div className="markdown-content">
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </div>
  );
}
