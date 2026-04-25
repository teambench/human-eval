import { test, expect, describe } from 'vitest';
import {
  taskSessionPath, metaPath,
  participantPath, participantProfilePath, participantInteractionsPath,
  participantInteractionsRawPath, participantSurveyPath,
  sharedArtifactsPath, sharedMessagesPath, sharedFilesPath,
  sharedAiTurnsPath, sharedAgentStatusPath, sharedLastGradePath,
  sharedInitialWorkspacePath, sharedFinalWorkspacePath,
  participantsIndexSessionPath, participantsIndexProfilePath,
} from '../firebasePaths';

describe('path builders', () => {
  const tid = 'API1_version_compat';
  const sid = 'API1_team_a3f9';
  const pid = 'a3f9d2c1b8e0';

  test('taskSessionPath roots at tasks/{tid}/{mode}/sessions/{sid}', () => {
    expect(taskSessionPath(tid, 'team', sid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}`);
  });

  test('oracle stays as oracle (no rename)', () => {
    expect(taskSessionPath(tid, 'oracle', sid))
      .toBe(`teambench/tasks/${tid}/oracle/sessions/${sid}`);
  });

  test('hybrid', () => {
    expect(taskSessionPath(tid, 'hybrid', sid))
      .toBe(`teambench/tasks/${tid}/hybrid/sessions/${sid}`);
  });

  test('metaPath', () => {
    expect(metaPath(tid, 'team', sid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}/meta`);
  });

  test('participantPath', () => {
    expect(participantPath(tid, 'team', sid, pid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}/participants/${pid}`);
  });

  test('participantProfilePath', () => {
    expect(participantProfilePath(tid, 'team', sid, pid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}/participants/${pid}/profile`);
  });

  test('participantInteractionsPath', () => {
    expect(participantInteractionsPath(tid, 'team', sid, pid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}/participants/${pid}/interactions`);
  });

  test('participantInteractionsRawPath is separate node', () => {
    expect(participantInteractionsRawPath(tid, 'team', sid, pid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}/participants/${pid}/interactionsRaw`);
  });

  test('participantSurveyPath', () => {
    expect(participantSurveyPath(tid, 'team', sid, pid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}/participants/${pid}/survey`);
  });

  test('sharedArtifactsPath nests under task session', () => {
    expect(sharedArtifactsPath(tid, 'team', sid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}/sharedArtifacts`);
  });

  test('sharedMessagesPath', () => {
    expect(sharedMessagesPath(tid, 'team', sid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}/sharedArtifacts/messages`);
  });

  test('sharedFilesPath', () => {
    expect(sharedFilesPath(tid, 'team', sid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}/sharedArtifacts/files`);
  });

  test('sharedAiTurnsPath', () => {
    expect(sharedAiTurnsPath(tid, 'hybrid', sid))
      .toBe(`teambench/tasks/${tid}/hybrid/sessions/${sid}/sharedArtifacts/aiTurns`);
  });

  test('sharedAgentStatusPath', () => {
    expect(sharedAgentStatusPath(tid, 'hybrid', sid))
      .toBe(`teambench/tasks/${tid}/hybrid/sessions/${sid}/sharedArtifacts/agentStatus`);
  });

  test('sharedLastGradePath', () => {
    expect(sharedLastGradePath(tid, 'team', sid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}/sharedArtifacts/lastGrade`);
  });

  test('sharedInitialWorkspacePath', () => {
    expect(sharedInitialWorkspacePath(tid, 'team', sid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}/sharedArtifacts/initialWorkspace`);
  });

  test('sharedFinalWorkspacePath', () => {
    expect(sharedFinalWorkspacePath(tid, 'team', sid))
      .toBe(`teambench/tasks/${tid}/team/sessions/${sid}/sharedArtifacts/finalWorkspace`);
  });

  test('participantsIndexSessionPath uses cross-task index', () => {
    expect(participantsIndexSessionPath(pid, sid))
      .toBe(`teambench/participants/${pid}/sessions/${sid}`);
  });

  test('participantsIndexProfilePath uses cross-task index', () => {
    expect(participantsIndexProfilePath(pid))
      .toBe(`teambench/participants/${pid}/profile`);
  });
});
