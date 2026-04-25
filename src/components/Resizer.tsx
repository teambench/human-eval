import { useCallback, useRef } from 'react';
import { useEventLogger } from '../lib/eventLogger';

interface ResizerProps {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
  panelId?: string;
}

export function Resizer({ direction, onResize, panelId }: ResizerProps) {
  const startPos = useRef(0);
  const totalDelta = useRef(0);
  const log = useEventLogger();

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
    totalDelta.current = 0;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const current = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
      const delta = current - startPos.current;
      startPos.current = current;
      totalDelta.current += delta;
      onResize(delta);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Emit one event per drag (commit), not per pixel.
      if (Math.abs(totalDelta.current) >= 4) {
        log('panel_resize', {
          panel: panelId || 'unknown',
          direction,
          deltaPx: totalDelta.current,
        });
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [direction, onResize, panelId, log]);

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
