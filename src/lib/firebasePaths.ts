/**
 * Path builders for the new structured Firebase tree (additive — does not
 * replace teambench/sessions/* which the live UI still reads/writes).
 *
 * Tree shape (rooted at teambench_new so it is fully isolated from the
 * legacy teambench/* tree — old test data stays where it is):
 *   teambench_new/tasks/{taskId}/{mode}/sessions/{sessionId}/
 *     meta/                              session-level metadata
 *     participants/{pid}/
 *       profile/                         email, name, role, ...
 *       interactions/{eventId}           curated event stream
 *       interactionsRaw/{eventId}        raw click stream (separate node)
 *       survey/                          per-participant survey response
 *     sharedArtifacts/
 *       messages/{msgId}                 chat
 *       files/{escapedPath}              current content (mirror of legacy)
 *       initialWorkspace/                snapshot at staging
 *       finalWorkspace/                  snapshot at completion
 *       lastGrade/                       grader output
 *       agentStatus/{role}               hybrid only — drives "thinking" badge
 *       aiTurns/{eventId}                hybrid only — full AI turn records
 *
 *   teambench_new/participants/{pid}/sessions/{sessionId}: {taskId, mode, role, ...}
 *
 * Mode is kept as the literal SessionMode value (`oracle` is NOT renamed
 * to `solo`) to minimize blast radius.
 */
import { SessionMode } from '../types';

const ROOT = 'teambench_new';

export function taskSessionPath(
  taskId: string, mode: SessionMode, sessionId: string,
): string {
  return `${ROOT}/tasks/${taskId}/${mode}/sessions/${sessionId}`;
}

export function metaPath(
  taskId: string, mode: SessionMode, sessionId: string,
): string {
  return `${taskSessionPath(taskId, mode, sessionId)}/meta`;
}

export function participantPath(
  taskId: string, mode: SessionMode, sessionId: string, pid: string,
): string {
  return `${taskSessionPath(taskId, mode, sessionId)}/participants/${pid}`;
}

export function participantProfilePath(
  taskId: string, mode: SessionMode, sessionId: string, pid: string,
): string {
  return `${participantPath(taskId, mode, sessionId, pid)}/profile`;
}

export function participantInteractionsPath(
  taskId: string, mode: SessionMode, sessionId: string, pid: string,
): string {
  return `${participantPath(taskId, mode, sessionId, pid)}/interactions`;
}

export function participantInteractionsRawPath(
  taskId: string, mode: SessionMode, sessionId: string, pid: string,
): string {
  return `${participantPath(taskId, mode, sessionId, pid)}/interactionsRaw`;
}

export function participantSurveyPath(
  taskId: string, mode: SessionMode, sessionId: string, pid: string,
): string {
  return `${participantPath(taskId, mode, sessionId, pid)}/survey`;
}

export function sharedArtifactsPath(
  taskId: string, mode: SessionMode, sessionId: string,
): string {
  return `${taskSessionPath(taskId, mode, sessionId)}/sharedArtifacts`;
}

export function sharedMessagesPath(
  taskId: string, mode: SessionMode, sessionId: string,
): string {
  return `${sharedArtifactsPath(taskId, mode, sessionId)}/messages`;
}

export function sharedFilesPath(
  taskId: string, mode: SessionMode, sessionId: string,
): string {
  return `${sharedArtifactsPath(taskId, mode, sessionId)}/files`;
}

export function sharedAiTurnsPath(
  taskId: string, mode: SessionMode, sessionId: string,
): string {
  return `${sharedArtifactsPath(taskId, mode, sessionId)}/aiTurns`;
}

export function sharedAgentStatusPath(
  taskId: string, mode: SessionMode, sessionId: string,
): string {
  return `${sharedArtifactsPath(taskId, mode, sessionId)}/agentStatus`;
}

export function sharedLastGradePath(
  taskId: string, mode: SessionMode, sessionId: string,
): string {
  return `${sharedArtifactsPath(taskId, mode, sessionId)}/lastGrade`;
}

export function sharedInitialWorkspacePath(
  taskId: string, mode: SessionMode, sessionId: string,
): string {
  return `${sharedArtifactsPath(taskId, mode, sessionId)}/initialWorkspace`;
}

export function sharedFinalWorkspacePath(
  taskId: string, mode: SessionMode, sessionId: string,
): string {
  return `${sharedArtifactsPath(taskId, mode, sessionId)}/finalWorkspace`;
}

export function participantsIndexSessionPath(
  pid: string, sessionId: string,
): string {
  return `${ROOT}/participants/${pid}/sessions/${sessionId}`;
}

export function participantsIndexProfilePath(pid: string): string {
  return `${ROOT}/participants/${pid}/profile`;
}
