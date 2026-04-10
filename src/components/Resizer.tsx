import { useCallback, useRef } from 'react';

interface ResizerProps {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
}

export function Resizer({ direction, onResize }: ResizerProps) {
  const startPos = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const current = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
      const delta = current - startPos.current;
      startPos.current = current;
      onResize(delta);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [direction, onResize]);

  const isHoriz = direction === 'horizontal';

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        width: isHoriz ? 5 : '100%',
        height: isHoriz ? '100%' : 5,
        cursor: isHoriz ? 'col-resize' : 'row-resize',
        background: 'transparent',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 5,
      }}
    >
      <div style={{
        width: isHoriz ? 1 : 20,
        height: isHoriz ? 20 : 1,
        background: '#555',
        borderRadius: 1,
      }} />
    </div>
  );
}
