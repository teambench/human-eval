import { useState, useCallback, useRef } from 'react';
import { SessionState, Role, ChatMessage, FileEntry, ActionLog, TaskConfig } from '../types';

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function useSession(task: TaskConfig) {
  const [session, setSession] = useState<SessionState>({
    sessionId: generateId(),
    taskConfig: task,
    participants: [],
    messages: [],
    files: task.files.map(f => ({ ...f })),
    logs: [],
    phase: 'lobby',
    startTime: null,
    endTime: null,
  });

  const logRef = useRef<ActionLog[]>([]);

  const addLog = useCallback((role: Role, action: string, detail: Record<string, unknown> = {}) => {
    const entry: ActionLog = {
      id: generateId(),
      participantId: role,
      role,
      action,
      detail,
      timestamp: Date.now(),
    };
    logRef.current.push(entry);
    setSession(s => ({ ...s, logs: [...logRef.current] }));
  }, []);

  const sendMessage = useCallback((from: Role, to: Role | 'all', content: string) => {
    const msg: ChatMessage = {
      id: generateId(),
      from,
      to,
      content,
      timestamp: Date.now(),
    };
    addLog(from, 'chat_send', { to, contentLength: content.length });
    setSession(s => ({ ...s, messages: [...s.messages, msg] }));
  }, [addLog]);

  const updateFile = useCallback((path: string, content: string, role: Role) => {
    addLog(role, 'file_edit', { path, contentLength: content.length });
    setSession(s => ({
      ...s,
      files: s.files.map(f => f.path === path ? { ...f, content } : f),
    }));
  }, [addLog]);

  const setPhase = useCallback((phase: SessionState['phase']) => {
    setSession(s => ({
      ...s,
      phase,
      startTime: s.startTime ?? (phase !== 'lobby' ? Date.now() : null),
      endTime: phase === 'completed' ? Date.now() : s.endTime,
    }));
  }, []);

  const getVisibleFiles = useCallback((role: Role): FileEntry[] => {
    return session.files.map(f => ({
      ...f,
      readOnly: role !== 'executor' ? true : f.readOnly,
    }));
  }, [session.files]);

  const getVisibleMessages = useCallback((role: Role): ChatMessage[] => {
    return session.messages.filter(m =>
      m.to === 'all' || m.from === role || m.to === role
    );
  }, [session.messages]);

  const exportLogs = useCallback(() => {
    const data = {
      sessionId: session.sessionId,
      taskId: session.taskConfig.taskId,
      startTime: session.startTime,
      endTime: session.endTime,
      phase: session.phase,
      messages: session.messages,
      logs: logRef.current,
      finalFiles: session.files.map(f => ({ path: f.path, content: f.content })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `teambench_${session.taskConfig.taskId}_${session.sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [session]);

  return {
    session,
    sendMessage,
    updateFile,
    setPhase,
    getVisibleFiles,
    getVisibleMessages,
    addLog,
    exportLogs,
  };
}
