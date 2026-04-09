export type Role = 'planner' | 'executor' | 'verifier';

export interface Participant {
  id: string;
  name: string;
  role: Role;
  joinedAt: number;
}

export interface ChatMessage {
  id: string;
  from: Role;
  to: Role | 'all';
  content: string;
  timestamp: number;
}

export interface FileEntry {
  path: string;
  content: string;
  language: string;
  readOnly: boolean;
}

export interface ActionLog {
  id: string;
  participantId: string;
  role: Role;
  action: string; // 'file_open' | 'file_edit' | 'chat_send' | 'command_run' | 'submit_plan' | 'submit_verdict'
  detail: Record<string, unknown>;
  timestamp: number;
}

export interface TaskConfig {
  taskId: string;
  category: string;
  difficulty: string;
  specMd: string;
  briefMd: string;
  files: FileEntry[];
  timeLimit: number; // seconds
}

export interface SessionState {
  sessionId: string;
  taskConfig: TaskConfig;
  participants: Participant[];
  messages: ChatMessage[];
  files: FileEntry[];
  logs: ActionLog[];
  phase: 'lobby' | 'planning' | 'execution' | 'verification' | 'completed';
  startTime: number | null;
  endTime: number | null;
}

export interface TerminalLine {
  id: number;
  type: 'input' | 'output' | 'error';
  content: string;
  timestamp: number;
}
