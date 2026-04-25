/**
 * Per-participant interaction event logger. Writes a curated taxonomy of
 * UI/lifecycle events to teambench/tasks/{taskId}/{mode}/sessions/{sid}/
 * participants/{pid}/interactions/, plus a separate raw-click stream to
 * .../interactionsRaw/.
 *
 * Use:
 *   - Wrap routed views in <EventLoggerProvider value={ctx}>
 *   - Call useEventLogger() inside views to get logEvent(type, payload)
 *   - Mount <SessionTrackers /> once inside the provider to install
 *     idle / focus / visibility / raw-click document listeners
 *
 * All writes are fire-and-forget (errors logged, never thrown — must never
 * block the UX or interrupt React rendering).
 */
import {
  createContext, useContext, useCallback, useRef, useEffect, ReactNode,
  createElement,
} from 'react';
import { ref, push } from 'firebase/database';
import { db } from '../firebase';
import { SessionMode, Role } from '../types';
import {
  participantInteractionsPath, participantInteractionsRawPath,
} from './firebasePaths';

export interface LoggerContextValue {
  taskId: string;
  mode: SessionMode;
  sessionId: string;
  pid: string;
  role: Role;
}

const Ctx = createContext<LoggerContextValue | null>(null);

export interface EventLoggerProviderProps {
  value: LoggerContextValue | null;
  children: ReactNode;
}

export function EventLoggerProvider({ value, children }: EventLoggerProviderProps) {
  return createElement(Ctx.Provider, { value }, children);
}

function genId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function envelope(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  return {
    id: genId(),
    ts: now,
    tsISO: new Date(now).toISOString(),
    type,
    ...payload,
  };
}

async function pushSafe(path: string, body: Record<string, unknown>): Promise<void> {
  try {
    await push(ref(db, path), body);
  } catch (err) {
    console.warn('[eventLogger]', path, err);
  }
}

export function logEventWith(
  ctx: LoggerContextValue, type: string, payload: Record<string, unknown> = {},
): Promise<void> {
  return pushSafe(
    participantInteractionsPath(ctx.taskId, ctx.mode, ctx.sessionId, ctx.pid),
    envelope(type, payload),
  );
}

export function logRawClickWith(
  ctx: LoggerContextValue, payload: Record<string, unknown>,
): Promise<void> {
  return pushSafe(
    participantInteractionsRawPath(ctx.taskId, ctx.mode, ctx.sessionId, ctx.pid),
    envelope('raw_click', payload),
  );
}

/**
 * React hook bound to the provider. Returns a stable callback that
 * no-ops when no logger context is mounted (lobby/onboarding screens).
 */
export function useEventLogger(): (type: string, payload?: Record<string, unknown>) => void {
  const ctx = useContext(Ctx);
  const ctxRef = useRef(ctx);
  useEffect(() => { ctxRef.current = ctx; }, [ctx]);
  return useCallback((type: string, payload?: Record<string, unknown>) => {
    const c = ctxRef.current;
    if (!c) return;
    void logEventWith(c, type, payload || {});
  }, []);
}

export function useLoggerContext(): LoggerContextValue | null {
  return useContext(Ctx);
}

// ── Document-level trackers ─────────────────────────────────────────────

const IDLE_THRESHOLD_MS = 30_000;

export function useIdleTracker(): void {
  const ctx = useContext(Ctx);
  useEffect(() => {
    if (!ctx) return;
    const c = ctx;
    let lastActiveAt = Date.now();
    let idle = false;
    let idleStartAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function emitIdleStart() {
      if (idle) return;
      idle = true;
      idleStartAt = Date.now();
      void logEventWith(c, 'idle_start', { lastActiveAt });
    }
    function emitIdleEnd() {
      if (!idle) return;
      idle = false;
      const idleSeconds = Math.round((Date.now() - idleStartAt) / 1000);
      void logEventWith(c, 'idle_end', { idleSeconds });
    }
    function activity() {
      lastActiveAt = Date.now();
      if (idle) emitIdleEnd();
      if (timer) clearTimeout(timer);
      timer = setTimeout(emitIdleStart, IDLE_THRESHOLD_MS);
    }

    activity();
    window.addEventListener('mousemove', activity, { passive: true });
    window.addEventListener('keydown', activity, { passive: true });
    window.addEventListener('scroll', activity, { passive: true, capture: true });

    return () => {
      window.removeEventListener('mousemove', activity);
      window.removeEventListener('keydown', activity);
      window.removeEventListener('scroll', activity, true);
      if (timer) clearTimeout(timer);
      if (idle) emitIdleEnd();
    };
  }, [ctx]);
}

export function useEngagementTracker(): void {
  const ctx = useContext(Ctx);
  useEffect(() => {
    if (!ctx) return;
    const c = ctx;
    function onFocus() { void logEventWith(c, 'window_focus', {}); }
    function onBlur()  { void logEventWith(c, 'window_blur', {}); }
    function onVis()   { void logEventWith(c, 'tab_visibility_change', { state: document.visibilityState }); }
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ctx]);
}

export function useRawClickCapture(): void {
  const ctx = useContext(Ctx);
  useEffect(() => {
    if (!ctx) return;
    const c = ctx;
    function onClick(e: MouseEvent) {
      const tgt = e.target as HTMLElement | null;
      if (!tgt) return;
      void logRawClickWith(c, {
        tagName: tgt.tagName,
        ariaLabel: tgt.getAttribute('aria-label') || undefined,
        text: (tgt.textContent || '').trim().slice(0, 80) || undefined,
        x: e.clientX, y: e.clientY,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      });
    }
    document.addEventListener('click', onClick, { capture: true, passive: true });
    return () => document.removeEventListener('click', onClick, true);
  }, [ctx]);
}

/** Single component to mount inside the provider — installs all three trackers. */
export function SessionTrackers(): null {
  useIdleTracker();
  useEngagementTracker();
  useRawClickCapture();
  return null;
}
