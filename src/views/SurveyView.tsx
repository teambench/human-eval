import { useState } from 'react';
import { ref, set } from 'firebase/database';
import { db } from '../firebase';
import { Role, SessionMode } from '../types';
import { participantSurveyPath } from '../lib/firebasePaths';
import { useEventLogger } from '../lib/eventLogger';

/**
 * CATME-lite Post-Task Survey
 *
 * Distilled from the CATME Behaviorally Anchored Rating Scale (Ohland et al., 2012).
 * Five dimensions, each rated 1–5 Likert, ~3 minutes to complete.
 */

interface SurveyViewProps {
  sessionId: string;
  taskId: string;
  role: Role;
  mode: SessionMode;
  pid: string;   // empty string if email wasn't captured (no v2 mirror in that case)
  participants: Record<string, { name: string; joinedAt: number }>;
  onComplete: () => void;
}

interface Dimension {
  id: string;
  label: string;
  prompt: string;
  anchorLow: string;
  anchorMid: string;
  anchorHigh: string;
}

const DIMENSIONS: Dimension[] = [
  {
    id: 'contributing',
    label: 'Contributing to the Team\'s Work',
    prompt: 'This role contributed meaningfully to the task',
    anchorLow: 'Did not do a fair share; sloppy or incomplete work',
    anchorMid: 'Completed assignments on time; acceptable quality',
    anchorHigh: 'Made important contributions; helped others',
  },
  {
    id: 'interacting',
    label: 'Interacting with Teammates',
    prompt: 'This role communicated effectively with the team',
    anchorLow: 'Took actions without input; didn\'t share info',
    anchorMid: 'Listened and shared; participated in activities',
    anchorHigh: 'Encouraged communication; sought and used feedback',
  },
  {
    id: 'keeping_on_track',
    label: 'Keeping the Team on Track',
    prompt: 'This role helped keep the team focused and on track',
    anchorLow: 'Unaware of progress; avoided discussing problems',
    anchorMid: 'Noticed issues; alerted team when threatened',
    anchorHigh: 'Monitored progress; gave timely, constructive feedback',
  },
  {
    id: 'expecting_quality',
    label: 'Expecting Quality',
    prompt: 'This role maintained high quality standards',
    anchorLow: 'Satisfied even if work didn\'t meet standards',
    anchorMid: 'Encouraged good work; wanted to meet requirements',
    anchorHigh: 'Motivated excellence; believed team could do outstanding work',
  },
  {
    id: 'knowledge_skills',
    label: 'Having Relevant Knowledge & Skills',
    prompt: 'This role demonstrated relevant technical skills',
    anchorLow: 'Missing basic qualifications; unable to contribute',
    anchorMid: 'Had sufficient skills; could do some other members\' tasks',
    anchorHigh: 'Strong skills; could perform any team member\'s role',
  },
];

const TEAM_ROLES: Role[] = ['planner', 'executor', 'verifier'];

const ROLE_COLORS: Record<string, string> = {
  planner: '#6366f1',
  executor: '#f59e0b',
  verifier: '#10b981',
  self: '#cba6f7',
};

const ROLE_LABELS: Record<string, string> = {
  planner: 'Planner',
  executor: 'Executor',
  verifier: 'Verifier',
  oracle: 'Oracle',
};

function LikertScale({ name, value, onChange }: {
  name: string;
  value: number | null;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 0, width: '100%' }}>
      {[1, 2, 3, 4, 5].map(v => (
        <label key={v} style={{ flex: 1, textAlign: 'center', cursor: 'pointer' }}>
          <div
            onClick={() => onChange(v)}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              padding: '8px 4px', borderRadius: 8,
              transition: 'background 0.15s',
              background: value === v ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
            }}
            onMouseEnter={e => { if (value !== v) (e.currentTarget as HTMLDivElement).style.background = '#1e1e2e'; }}
            onMouseLeave={e => { if (value !== v) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
          >
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              border: `2px solid ${value === v ? '#6366f1' : '#444'}`,
              background: value === v ? '#6366f1' : 'transparent',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 700,
              color: value === v ? '#fff' : '#666',
              transition: 'all 0.15s',
            }}>
              {v}
            </div>
          </div>
        </label>
      ))}
    </div>
  );
}

// ── Solo-mode task-level questions (NASA-TLX inspired + counterfactual) ──
interface SoloItem {
  id: string;
  label: string;
  prompt: string;
  anchorLow: string;
  anchorHigh: string;
}

const SOLO_TASK_ITEMS: SoloItem[] = [
  {
    id: 'difficulty',
    label: 'Task Difficulty',
    prompt: 'How difficult was this task overall?',
    anchorLow: 'Trivial',
    anchorHigh: 'Extremely hard',
  },
  {
    id: 'mental_effort',
    label: 'Mental Effort',
    prompt: 'How much mental effort did this task require?',
    anchorLow: 'Very little',
    anchorHigh: 'Maximum effort',
  },
  {
    id: 'time_pressure',
    label: 'Time Pressure',
    prompt: 'How rushed did you feel completing this task?',
    anchorLow: 'No pressure',
    anchorHigh: 'Extremely rushed',
  },
  {
    id: 'confidence',
    label: 'Confidence in Solution',
    prompt: 'How confident are you that your solution is correct?',
    anchorLow: 'Very unsure',
    anchorHigh: 'Certain',
  },
];

// Solo-mode counterfactual — concrete, role-mapped statements.
//
// Rationale: The earlier CATME-dimension counterfactual ("would a teammate
// focused on 'expecting quality' have helped?") was tautological and confusing
// in solo mode — CATME dimensions describe teammate BEHAVIOR, not task
// difficulty. These replacement items each map to a concrete counterfactual
// (would an extra person in a specific role have helped on THIS task) that
// aligns 1:1 with the TeamBench Planner/Executor/Verifier role structure,
// plus two orthogonal items (domain expertise, more time) to distinguish
// "teamwork would've helped" from "I just needed more minutes".
// ── Team-mode add-ons (task-level, answered once; not per-peer) ──
//
// CATME alone measures "was this a good teammate" but not the TeamBench-
// specific questions: information flow, handoff efficiency, and role-specific
// functional value. These six items surface exactly those.
const TEAM_COORDINATION: SoloItem[] = [
  {
    id: 'info_held_by_other',
    label: 'Information asymmetry',
    prompt: 'Important information was held by another role when I needed it.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'comms_overhead',
    label: 'Communication overhead',
    prompt: 'Communication overhead slowed our team down substantially.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'early_plan',
    label: 'Early alignment',
    prompt: 'Our team identified the right plan early.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'executor_efficiency',
    label: 'Executor efficiency',
    prompt: 'The Executor converted team discussion into concrete progress efficiently.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'verifier_value',
    label: 'Verifier value',
    prompt: 'The Verifier caught important mistakes or risky assumptions.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'role_separation_helped',
    label: 'Role separation net value',
    prompt: 'Role separation helped more than it hurt on this task.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
];

// Counterfactual "stronger X would have changed the outcome" — three items
// that let us identify which role(s) each task category is most sensitive to.
const TEAM_ROLE_NEED: SoloItem[] = [
  {
    id: 'stronger_planner',
    label: 'Planner sensitivity',
    prompt: 'A stronger Planner would likely have changed the outcome.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'stronger_executor',
    label: 'Executor sensitivity',
    prompt: 'A stronger Executor would likely have changed the outcome.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'stronger_verifier',
    label: 'Verifier sensitivity',
    prompt: 'A stronger Verifier would likely have changed the outcome.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
];

// Role-specific behavioral items appended to each peer's rating block. Using
// behavior-grounded prompts (not generic "quality") avoids the halo effect
// that contaminates CATME ratings once the team knows whether they passed.
const ROLE_SPECIFIC_ITEMS: Record<string, { id: string; label: string; prompt: string; anchorLow: string; anchorHigh: string }[]> = {
  planner: [
    { id: 'clarified_objective', label: 'Objective clarification',
      prompt: 'This teammate clarified the core objective and reduced wasted effort.',
      anchorLow: 'Strongly disagree', anchorHigh: 'Strongly agree' },
    { id: 'identified_subproblems', label: 'Subproblem identification',
      prompt: 'This teammate identified the right subproblems early.',
      anchorLow: 'Strongly disagree', anchorHigh: 'Strongly agree' },
  ],
  executor: [
    { id: 'turned_discussion_into_progress', label: 'Concrete progress',
      prompt: 'This teammate turned team discussion into concrete progress efficiently.',
      anchorLow: 'Strongly disagree', anchorHigh: 'Strongly agree' },
    { id: 'surfaced_blockers', label: 'Blocker surfacing',
      prompt: 'This teammate surfaced implementation blockers quickly.',
      anchorLow: 'Strongly disagree', anchorHigh: 'Strongly agree' },
  ],
  verifier: [
    { id: 'caught_mistakes', label: 'Mistake detection',
      prompt: 'This teammate caught important mistakes or risky assumptions.',
      anchorLow: 'Strongly disagree', anchorHigh: 'Strongly agree' },
    { id: 'improved_confidence', label: 'Correctness confidence',
      prompt: 'This teammate improved confidence that the final answer was correct.',
      anchorLow: 'Strongly disagree', anchorHigh: 'Strongly agree' },
  ],
};

// Structured single-choice "what factor most affected the outcome". Split by
// mode because solo users have no "cross-role information" to ask about, and
// team users have little point being asked about "tooling friction" vs the
// role-coordination failure modes we actually want to distinguish.
const TEAM_PRIMARY_FACTORS = [
  { id: 'missing_info_across_roles', label: 'Missing information across roles (one role knew something but it wasn\'t conveyed)' },
  { id: 'unclear_communication', label: 'Unclear communication (messages weren\'t specific or actionable)' },
  { id: 'weak_or_late_planning', label: 'Weak or late planning' },
  { id: 'implementation_difficulty', label: 'Implementation difficulty (the code change itself was hard)' },
  { id: 'missed_verification', label: 'Missed verification (a bug slipped through)' },
  { id: 'time_pressure', label: 'Time pressure (we knew what to do but ran out of time)' },
  { id: 'other', label: 'Other' },
];

const SOLO_PRIMARY_FACTORS = [
  { id: 'conceptual_hardness', label: 'The task was conceptually hard to reason about' },
  { id: 'implementation_tedium', label: 'Implementation was tedious or error-prone' },
  { id: 'missing_domain_knowledge', label: 'I lacked specific domain knowledge the task assumed' },
  { id: 'ambiguous_spec', label: 'The spec / requirements were ambiguous' },
  { id: 'tooling_friction', label: 'Tooling or environment friction (test setup, container, etc.)' },
  { id: 'time_pressure', label: 'Time pressure' },
  { id: 'other', label: 'Other' },
];

const SOLO_COUNTERFACTUAL: SoloItem[] = [
  {
    id: 'cf_planner',
    label: 'Help planning the approach (Planner role)',
    prompt: 'A second person to analyze the problem and lay out the solution approach would have been valuable on this task.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'cf_executor',
    label: 'Help sharing the implementation workload',
    prompt: 'A second person to split the coding (write parts of the fix in parallel, or take over while I read/tested) would have been valuable on this task.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'cf_verifier',
    label: 'Help verifying correctness (Verifier role)',
    prompt: 'A second person to independently check my solution and catch mistakes would have been valuable on this task.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'cf_domain',
    label: 'Domain expertise I lacked',
    prompt: 'I lacked specific technical knowledge that someone with the right expertise could have provided.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'cf_time_only',
    label: 'Time alone would have sufficed',
    prompt: 'More time alone would have been enough — I did not need a teammate on this task.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
];

// ── Hybrid-mode (AI Planner + AI Executor + Human Verifier) items ─────
//
// Replaces SOLO_COUNTERFACTUAL for hybrid sessions. Counterfactual ("would
// a teammate have helped?") doesn't make sense in hybrid because the
// participant DID have AI teammates — what we want to measure is how
// useful those AI teammates actually were, and what the human Verifier
// role added on top of the auto-grader.
const HYBRID_AI_TEAMMATE: SoloItem[] = [
  {
    id: 'ai_planner_useful',
    label: 'AI Planner usefulness',
    prompt: 'The AI Planner\'s analysis was clear, accurate, and useful for grading the executor\'s work.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'ai_executor_quality',
    label: 'AI Executor quality',
    prompt: 'The AI Executor\'s code edits were the kind of fix I would have made myself.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'ai_planner_trust',
    label: 'Trust in AI Planner',
    prompt: 'I trusted the AI Planner\'s analysis without needing to verify it independently.',
    anchorLow: 'Did not trust',
    anchorHigh: 'Fully trusted',
  },
  {
    id: 'ai_executor_trust',
    label: 'Trust in AI Executor',
    prompt: 'I trusted the AI Executor\'s edits without needing to verify them independently.',
    anchorLow: 'Did not trust',
    anchorHigh: 'Fully trusted',
  },
  {
    id: 'human_planner_preferred',
    label: 'Prefer human Planner',
    prompt: 'On this task, a human Planner would have done a better job than the AI.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'human_executor_preferred',
    label: 'Prefer human Executor',
    prompt: 'On this task, a human Executor would have done a better job than the AI.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'verifier_role_value',
    label: 'Value of human Verifier role',
    prompt: 'My role as the human Verifier added value beyond what the auto-grader provides — I caught (or could have caught) issues the grader missed.',
    anchorLow: 'Strongly disagree',
    anchorHigh: 'Strongly agree',
  },
  {
    id: 'overrode_grader',
    label: 'Did you overrule the grader?',
    prompt: 'On this task, my final verdict differed from what the auto-grader said (PASS when grader failed, or FAIL when grader passed).',
    anchorLow: 'Definitely not',
    anchorHigh: 'Yes, I overruled',
  },
];

export function SurveyView({ sessionId, taskId, role, mode, pid, participants, onComplete }: SurveyViewProps) {
  const log = useEventLogger();
  const isTeam = mode === 'team';
  const isHybrid = mode === 'hybrid';

  // ── Team-mode state: peer + self ratings ──
  const targets: { id: string; label: string; type: 'peer' | 'self' }[] = [];
  if (isTeam) {
    for (const r of TEAM_ROLES) {
      if (r !== role) {
        const pName = participants[r]?.name;
        targets.push({
          id: r,
          label: `${ROLE_LABELS[r]}${pName ? ` (${pName})` : ''}`,
          type: 'peer',
        });
      }
    }
    targets.push({
      id: 'self',
      label: `${ROLE_LABELS[role]} (yourself)`,
      type: 'self',
    });
  }

  // All Likert items pre-default to 3 (neutral) so the participant can scan
  // the form and only adjust items where they disagree — much lower
  // cognitive load than clicking every item.
  // BUT: every visible Likert input also tracks whether the user actually
  // CLICKED it. The analysis pipeline filters on this flag to distinguish
  // "deliberate 3" from "kept default" — otherwise the paper's means would
  // be silently biased toward 3 (Krosnick 1991 satisficing).
  const DEFAULT_LIKERT = 3;
  const initFlat = (items: { id: string }[]) =>
    Object.fromEntries(items.map(i => [i.id, DEFAULT_LIKERT]));
  const initNested = (targetIds: string[], items: { id: string }[]) =>
    Object.fromEntries(targetIds.map(t => [t, initFlat(items)]));

  const [ratings, setRatings] = useState<Record<string, Record<string, number>>>(
    () => isTeam ? initNested(targets.map(t => t.id), DIMENSIONS) : {},
  );
  // Role-specific behavioral items per peer: roleSpecific[peerRole][itemId] = n.
  const [roleSpecific, setRoleSpecific] = useState<Record<string, Record<string, number>>>(
    () => isTeam
      ? Object.fromEntries(targets.filter(t => t.type === 'peer')
          .map(t => [t.id, initFlat(ROLE_SPECIFIC_ITEMS[t.id] ?? [])]))
      : {},
  );
  // ── Team-mode add-ons ──
  const [coordination, setCoordination] = useState<Record<string, number>>(() => initFlat(TEAM_COORDINATION));
  const [roleNeed, setRoleNeed] = useState<Record<string, number>>(() => initFlat(TEAM_ROLE_NEED));
  // ── Solo-mode state ──
  const [taskItems, setTaskItems] = useState<Record<string, number>>(() => initFlat(SOLO_TASK_ITEMS));
  const [counterfactual, setCounterfactual] = useState<Record<string, number>>(() => initFlat(SOLO_COUNTERFACTUAL));
  // ── Hybrid-mode state (AI Planner + AI Executor + Human Verifier) ──
  const [hybridAiTeammate, setHybridAiTeammate] = useState<Record<string, number>>(() => initFlat(HYBRID_AI_TEAMMATE));

  // Set of item IDs the user actively interacted with. Items never touched
  // mean the participant accepted the default 3 — analysis filters on this.
  // Keys are namespaced by block so duplicates across blocks don't collide.
  const [touchedItems, setTouchedItems] = useState<Set<string>>(new Set());
  const markTouched = (key: string) =>
    setTouchedItems(prev => prev.has(key) ? prev : new Set(prev).add(key));
  // ── Shared: structured primary-factor (both modes) ──
  // Was forced single-choice; per user feedback, allow multi-select since
  // tasks usually have several contributing factors. Cap at 3 so the field
  // still surfaces "primary" causes — without a cap, participants will check
  // everything and the field loses signal.
  const PRIMARY_FACTOR_MAX = 3;
  const [primaryFactors, setPrimaryFactors] = useState<Set<string>>(new Set());
  const togglePrimaryFactor = (id: string) =>
    setPrimaryFactors(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < PRIMARY_FACTOR_MAX) next.add(id);
      return next;
    });
  const [primaryFactorNote, setPrimaryFactorNote] = useState('');

  // ── Attention check: always required. Correct answer is the value
  // referenced in the prompt; lets us filter out straight-line responders. ──
  const [attention, setAttention] = useState<number | null>(null);

  const [challenge, setChallenge] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const setRating = (targetId: string, dimId: string, value: number) => {
    setRatings(prev => ({
      ...prev,
      [targetId]: { ...prev[targetId], [dimId]: value },
    }));
  };

  // Validation. Attention check + primary-factor are required in both modes.
  let totalRequired = 2;
  let totalFilled = (attention !== null ? 1 : 0) + (primaryFactors.size > 0 ? 1 : 0);
  if (isTeam) {
    totalRequired += targets.length * DIMENSIONS.length;
    totalFilled += Object.values(ratings).reduce((sum, dims) => sum + Object.keys(dims).length, 0);
    // Role-specific items: 2 per peer (not self).
    const peerCount = targets.filter(t => t.type === 'peer').length;
    totalRequired += peerCount * 2;
    totalFilled += Object.values(roleSpecific).reduce((sum, items) => sum + Object.keys(items).length, 0);
    totalRequired += TEAM_COORDINATION.length + TEAM_ROLE_NEED.length;
    totalFilled += Object.keys(coordination).length + Object.keys(roleNeed).length;
  } else if (isHybrid) {
    // Hybrid still asks the universal task experience (difficulty/effort/...)
    // but swaps counterfactual for HYBRID_AI_TEAMMATE since the participant
    // actually had AI teammates.
    totalRequired += SOLO_TASK_ITEMS.length + HYBRID_AI_TEAMMATE.length;
    totalFilled += Object.keys(taskItems).length + Object.keys(hybridAiTeammate).length;
  } else {
    totalRequired += SOLO_TASK_ITEMS.length + SOLO_COUNTERFACTUAL.length;
    totalFilled += Object.keys(taskItems).length + Object.keys(counterfactual).length;
  }
  const allFilled = totalFilled >= totalRequired;
  const progress = Math.round((totalFilled / totalRequired) * 100);

  const handleSubmit = async () => {
    if (!allFilled || submitting) return;
    setSubmitting(true);

    let surveyData: Record<string, unknown>;
    if (isTeam) {
      const peerRatings: Record<string, Record<string, number>> = {};
      let selfRating: Record<string, number> = {};
      for (const [targetId, dims] of Object.entries(ratings)) {
        if (targetId === 'self') selfRating = dims;
        else peerRatings[targetId] = dims;
      }
      surveyData = {
        schema_version: '2.0',
        instrument: 'CATME-lite + TeamBench Coordination',
        reference: 'Ohland et al. (2012) + TeamBench role-specific extension',
        timestamp: Date.now(),
        timestampISO: new Date().toISOString(),
        sessionId, taskId, mode,
        respondentRole: role,
        peerRatings, selfRating,
        // Role-specific behavioral items per peer. Keyed by peer role so we
        // know WHICH role each item was answered about.
        peerRoleSpecific: roleSpecific,
        // Task-level task-bench items (answered once, not per peer).
        coordination,   // 6 items: info asymmetry, comms overhead, early plan, executor/verifier value, role-sep net
        roleNeed,       // 3 items: "stronger planner/executor/verifier would have changed outcome"
        // Structured failure-factor + optional note.
        primaryFactors: Array.from(primaryFactors),
        primaryFactorNote,
        attentionCheck: { expected: 3, answer: attention, passed: attention === 3 },
        openEnded: { collaborationChallenge: challenge },
        // Items the participant explicitly clicked. Items NOT in this set
        // were left at the default 3 — analysis must distinguish "deliberate
        // 3" from "kept default" or means will be biased toward midpoint.
        touchedItems: Array.from(touchedItems),
      };
    } else if (isHybrid) {
      surveyData = {
        schema_version: '2.0',
        instrument: 'TeamBench-Hybrid-Reflection',
        reference: 'NASA-TLX (Hart & Staveland, 1988) + AI-trust scale',
        timestamp: Date.now(),
        timestampISO: new Date().toISOString(),
        sessionId, taskId, mode,
        respondentRole: role,
        taskExperience: taskItems,                  // difficulty/effort/pressure/confidence
        // 8 items: AI Planner/Executor usefulness + trust, human-preferred
        // alternates, Verifier-role value, did-you-overrule-grader.
        hybridAiTeammate,
        primaryFactors: Array.from(primaryFactors),
        primaryFactorNote,
        attentionCheck: { expected: 3, answer: attention, passed: attention === 3 },
        openEnded: { collaborationChallenge: challenge },
        touchedItems: Array.from(touchedItems),
      };
    } else {
      surveyData = {
        schema_version: '2.0',
        instrument: 'TeamBench-Solo-Reflection',
        reference: 'NASA-TLX (Hart & Staveland, 1988) + CATME counterfactual',
        timestamp: Date.now(),
        timestampISO: new Date().toISOString(),
        sessionId, taskId, mode,
        respondentRole: role,
        taskExperience: taskItems,                  // difficulty/effort/pressure/confidence
        counterfactualTeamValue: counterfactual,    // role counterfactual + domain + time
        primaryFactors: Array.from(primaryFactors),
        primaryFactorNote,
        attentionCheck: { expected: 3, answer: attention, passed: attention === 3 },
        openEnded: { collaborationChallenge: challenge },
        touchedItems: Array.from(touchedItems),
      };
    }

    try {
      await set(ref(db, `teambench/sessions/${sessionId}/survey/${role}`), surveyData);
    } catch (err) {
      console.error('Failed to save survey:', err);
    }
    // v2 mirror — survey is keyed by role so the same pid can never overwrite
    // their own answers if (defensively) they ever fill more than one role.
    // Path is teambench_new/tasks/{taskId}/{mode}/sessions/{sid}/participants/
    //         {pid}/survey/{role}/.
    if (pid) {
      try {
        await set(ref(db, participantSurveyPath(taskId, mode, sessionId, pid, role)), surveyData);
      } catch (err) {
        console.warn('[v2 survey write]', err);
      }
    }
    log('survey_submit', { instrumentVersion: surveyData.schema_version });

    setSubmitting(false);
    onComplete();
  };

  return (
    <div style={{
      minHeight: '100vh', background: '#11111b', display: 'flex',
      justifyContent: 'center', padding: '32px 16px',
    }}>
      <div style={{ maxWidth: 680, width: '100%' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1 style={{ color: '#cdd6f4', fontSize: 24, fontWeight: 700, margin: '0 0 4px' }}>
            {isTeam ? 'Teamwork Effectiveness Survey' : 'Post-Task Reflection'}
          </h1>
          <p style={{ color: '#585b70', fontSize: 13, margin: '0 0 4px' }}>
            {taskId} &middot; Your role: {ROLE_LABELS[role]}
          </p>
          <p style={{ color: '#6c7086', fontSize: 12 }}>
            {isTeam
              ? 'Based on CATME BARS (Ohland et al., 2012) · ~3 minutes'
              : 'Task experience + counterfactual team value · ~3 minutes'}
          </p>
        </div>

        {/* Progress bar */}
        <div style={{
          background: '#1e1e2e', borderRadius: 8, height: 6, marginBottom: 24,
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', background: allFilled ? '#a6e3a1' : '#6366f1',
            width: `${progress}%`, transition: 'width 0.3s, background 0.3s',
            borderRadius: 8,
          }} />
        </div>

        {/* Info box */}
        <div style={{
          background: 'rgba(99, 102, 241, 0.08)', border: '1px solid rgba(99, 102, 241, 0.2)',
          borderRadius: 8, padding: '10px 14px', marginBottom: 24,
          fontSize: 13, color: '#a6adc8',
        }}>
          <strong style={{ color: '#6366f1' }}>Instructions:</strong>{' '}
          {isTeam
            ? 'Rate each team member on five dimensions of teamwork effectiveness. Please complete this survey immediately — your impressions are most accurate right after the task.'
            : 'Rate your task experience, then indicate which team-effectiveness dimensions a teammate would have helped on. Please complete immediately — your impressions are most accurate right after the task.'}
        </div>

        {/* ── Solo: task experience block ── */}
        {!isTeam && (
          <div style={{
            background: '#1e1e2e', border: '1px solid #313244',
            borderRadius: 12, padding: 20, marginBottom: 16,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '3px 8px',
                borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.05em',
                background: 'rgba(203, 166, 247, 0.15)', color: '#cba6f7',
              }}>
                Task Experience
              </span>
              <span style={{ fontSize: 13, color: '#6c7086' }}>
                Rate your experience completing this task alone
              </span>
            </div>
            {SOLO_TASK_ITEMS.map((item, i) => (
              <div key={item.id} style={{
                paddingBottom: i < SOLO_TASK_ITEMS.length - 1 ? 16 : 0,
                marginBottom: i < SOLO_TASK_ITEMS.length - 1 ? 16 : 0,
                borderBottom: i < SOLO_TASK_ITEMS.length - 1 ? '1px solid #313244' : 'none',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4', marginBottom: 2 }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 12, color: '#6c7086', marginBottom: 8 }}>
                  {item.prompt}
                </div>
                <LikertScale
                  name={`task_${item.id}`}
                  value={taskItems[item.id] ?? null}
                  onChange={v => { markTouched(`taskItems.${item.id}`); setTaskItems(prev => ({ ...prev, [item.id]: v })); }}
                />
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 10, color: '#45475a', marginTop: 2, padding: '0 4px',
                }}>
                  <span>{item.anchorLow}</span>
                  <span>{item.anchorHigh}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Solo: counterfactual "would teamwork have helped?" ── */}
        {!isTeam && !isHybrid && (
          <div style={{
            background: '#1e1e2e', border: '1px solid #313244',
            borderRadius: 12, padding: 20, marginBottom: 16,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '3px 8px',
                borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.05em',
                background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b',
              }}>
                Counterfactual
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4' }}>
                What kind of help would have been most valuable on this task?
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#6c7086', marginBottom: 16 }}>
              Rate how much you agree with each statement (1 = strongly disagree, 5 = strongly agree).
            </div>
            {SOLO_COUNTERFACTUAL.map((item, i) => (
              <div key={item.id} style={{
                paddingBottom: i < SOLO_COUNTERFACTUAL.length - 1 ? 16 : 0,
                marginBottom: i < SOLO_COUNTERFACTUAL.length - 1 ? 16 : 0,
                borderBottom: i < SOLO_COUNTERFACTUAL.length - 1 ? '1px solid #313244' : 'none',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4', marginBottom: 2 }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 12, color: '#6c7086', marginBottom: 8 }}>
                  {item.prompt}
                </div>
                <LikertScale
                  name={`counterfactual_${item.id}`}
                  value={counterfactual[item.id] ?? null}
                  onChange={v => { markTouched(`counterfactual.${item.id}`); setCounterfactual(prev => ({ ...prev, [item.id]: v })); }}
                />
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 10, color: '#45475a', marginTop: 2, padding: '0 4px',
                }}>
                  <span>{item.anchorLow}</span>
                  <span>{item.anchorHigh}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Hybrid: AI-teammate quality + trust + Verifier-role value ── */}
        {isHybrid && (
          <div style={{
            background: '#1e1e2e', border: '1px solid #313244',
            borderRadius: 12, padding: 20, marginBottom: 16,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '3px 8px',
                borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.05em',
                background: 'rgba(16, 185, 129, 0.15)', color: '#10b981',
              }}>
                AI Teammates
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4' }}>
                How were the AI Planner and AI Executor on this task?
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#6c7086', marginBottom: 16 }}>
              Rate how much you agree with each statement (1 = strongly disagree, 5 = strongly agree).
            </div>
            {HYBRID_AI_TEAMMATE.map((item, i) => (
              <div key={item.id} style={{
                paddingBottom: i < HYBRID_AI_TEAMMATE.length - 1 ? 16 : 0,
                marginBottom: i < HYBRID_AI_TEAMMATE.length - 1 ? 16 : 0,
                borderBottom: i < HYBRID_AI_TEAMMATE.length - 1 ? '1px solid #313244' : 'none',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4', marginBottom: 2 }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 12, color: '#6c7086', marginBottom: 8 }}>
                  {item.prompt}
                </div>
                <LikertScale
                  name={`hybrid_ai_${item.id}`}
                  value={hybridAiTeammate[item.id] ?? null}
                  onChange={v => { markTouched(`hybridAiTeammate.${item.id}`); setHybridAiTeammate(prev => ({ ...prev, [item.id]: v })); }}
                />
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 10, color: '#45475a', marginTop: 2, padding: '0 4px',
                }}>
                  <span>{item.anchorLow}</span>
                  <span>{item.anchorHigh}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Team: peer + self rating sections ── */}
        {isTeam && targets.map(target => (
          <div key={target.id} style={{
            background: '#1e1e2e', border: '1px solid #313244',
            borderRadius: 12, padding: 20, marginBottom: 16,
          }}>
            {/* Section header */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '3px 8px',
                borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.05em',
                background: `${ROLE_COLORS[target.type === 'self' ? 'self' : target.id]}22`,
                color: ROLE_COLORS[target.type === 'self' ? 'self' : target.id],
              }}>
                {target.type === 'self' ? 'Self' : 'Peer'}
              </span>
              <span style={{ fontSize: 15, fontWeight: 600, color: '#cdd6f4' }}>
                {target.label}
              </span>
            </div>

            {/* CATME-lite dimensions */}
            {DIMENSIONS.map((dim, i) => (
              <div key={dim.id} style={{
                paddingBottom: 16, marginBottom: 16,
                borderBottom: '1px solid #313244',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4', marginBottom: 2 }}>
                  {dim.label}
                </div>
                <div style={{ fontSize: 12, color: '#6c7086', marginBottom: 8 }}>
                  {dim.prompt}
                </div>
                <LikertScale
                  name={`${target.id}_${dim.id}`}
                  value={ratings[target.id]?.[dim.id] ?? null}
                  onChange={v => { markTouched(`ratings.${target.id}.${dim.id}`); setRating(target.id, dim.id, v); }}
                />
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 10, color: '#45475a', marginTop: 2, padding: '0 4px',
                }}>
                  <span style={{ maxWidth: '35%' }}>{dim.anchorLow}</span>
                  <span style={{ maxWidth: '35%', textAlign: 'right' }}>{dim.anchorHigh}</span>
                </div>
              </div>
            ))}

            {/* Role-specific behavioral items (peers only). CATME measures
                generic teamwork quality but misses role-specific functional
                value — e.g. a Verifier who barely spoke but caught a critical
                bug, or a Planner who saved rework via an early course
                correction. Two behavior-grounded items per peer surface that. */}
            {target.type === 'peer' && ROLE_SPECIFIC_ITEMS[target.id] && (
              <>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: '#6c7086',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                  marginBottom: 12, marginTop: 4,
                }}>
                  Role-specific behaviors
                </div>
                {ROLE_SPECIFIC_ITEMS[target.id].map((item, i) => (
                  <div key={item.id} style={{
                    paddingBottom: i < ROLE_SPECIFIC_ITEMS[target.id].length - 1 ? 16 : 0,
                    marginBottom: i < ROLE_SPECIFIC_ITEMS[target.id].length - 1 ? 16 : 0,
                    borderBottom: i < ROLE_SPECIFIC_ITEMS[target.id].length - 1 ? '1px solid #313244' : 'none',
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4', marginBottom: 2 }}>
                      {item.label}
                    </div>
                    <div style={{ fontSize: 12, color: '#6c7086', marginBottom: 8 }}>
                      {item.prompt}
                    </div>
                    <LikertScale
                      name={`rs_${target.id}_${item.id}`}
                      value={roleSpecific[target.id]?.[item.id] ?? null}
                      onChange={v => {
                        markTouched(`roleSpecific.${target.id}.${item.id}`);
                        setRoleSpecific(prev => ({
                          ...prev,
                          [target.id]: { ...prev[target.id], [item.id]: v },
                        }));
                      }}
                    />
                    <div style={{
                      display: 'flex', justifyContent: 'space-between',
                      fontSize: 10, color: '#45475a', marginTop: 2, padding: '0 4px',
                    }}>
                      <span>{item.anchorLow}</span>
                      <span>{item.anchorHigh}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        ))}

        {/* ── Team-only: TeamBench Coordination Block (task-level) ──
            Six items that isolate what CATME misses: information flow,
            handoff efficiency, and role-specific functional value. */}
        {isTeam && (
          <div style={{
            background: '#1e1e2e', border: '1px solid #313244',
            borderRadius: 12, padding: 20, marginBottom: 16,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '3px 8px',
                borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.05em',
                background: 'rgba(137, 180, 250, 0.15)', color: '#89b4fa',
              }}>
                Coordination
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4' }}>
                How did the team work together on this specific task?
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#6c7086', marginBottom: 16 }}>
              Think about the task you just finished — not teamwork in general. Rate each 1 = strongly disagree, 5 = strongly agree.
            </div>
            {TEAM_COORDINATION.map((item, i) => (
              <div key={item.id} style={{
                paddingBottom: i < TEAM_COORDINATION.length - 1 ? 16 : 0,
                marginBottom: i < TEAM_COORDINATION.length - 1 ? 16 : 0,
                borderBottom: i < TEAM_COORDINATION.length - 1 ? '1px solid #313244' : 'none',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4', marginBottom: 2 }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 12, color: '#6c7086', marginBottom: 8 }}>
                  {item.prompt}
                </div>
                <LikertScale
                  name={`coord_${item.id}`}
                  value={coordination[item.id] ?? null}
                  onChange={v => { markTouched(`coordination.${item.id}`); setCoordination(prev => ({ ...prev, [item.id]: v })); }}
                />
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 10, color: '#45475a', marginTop: 2, padding: '0 4px',
                }}>
                  <span>{item.anchorLow}</span>
                  <span>{item.anchorHigh}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Team-only: Role Need counterfactual ── */}
        {isTeam && (
          <div style={{
            background: '#1e1e2e', border: '1px solid #313244',
            borderRadius: 12, padding: 20, marginBottom: 16,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6,
            }}>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '3px 8px',
                borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.05em',
                background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b',
              }}>
                Role Sensitivity
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4' }}>
                Which role, if stronger, would have most affected the outcome?
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#6c7086', marginBottom: 16 }}>
              This helps us identify which tasks are sensitive to which role.
            </div>
            {TEAM_ROLE_NEED.map((item, i) => (
              <div key={item.id} style={{
                paddingBottom: i < TEAM_ROLE_NEED.length - 1 ? 16 : 0,
                marginBottom: i < TEAM_ROLE_NEED.length - 1 ? 16 : 0,
                borderBottom: i < TEAM_ROLE_NEED.length - 1 ? '1px solid #313244' : 'none',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4', marginBottom: 2 }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 12, color: '#6c7086', marginBottom: 8 }}>
                  {item.prompt}
                </div>
                <LikertScale
                  name={`need_${item.id}`}
                  value={roleNeed[item.id] ?? null}
                  onChange={v => { markTouched(`roleNeed.${item.id}`); setRoleNeed(prev => ({ ...prev, [item.id]: v })); }}
                />
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: 10, color: '#45475a', marginTop: 2, padding: '0 4px',
                }}>
                  <span>{item.anchorLow}</span>
                  <span>{item.anchorHigh}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Primary Factor single-choice (both modes, mode-aware options) ── */}
        <div style={{
          background: '#1e1e2e', border: '1px solid #313244',
          borderRadius: 12, padding: 20, marginBottom: 16,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6,
          }}>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '3px 8px',
              borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.05em',
              background: 'rgba(243, 139, 168, 0.15)', color: '#f38ba8',
            }}>
              Primary Factor
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4' }}>
              {isTeam
                ? `Which factors most affected your team's outcome on this task? (select up to ${PRIMARY_FACTOR_MAX})`
                : `Which factors most affected how well you did on this task? (select up to ${PRIMARY_FACTOR_MAX})`}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
            {(isTeam ? TEAM_PRIMARY_FACTORS : SOLO_PRIMARY_FACTORS).map(pf => {
              const active = primaryFactors.has(pf.id);
              const disabled = !active && primaryFactors.size >= PRIMARY_FACTOR_MAX;
              return (
                <div
                  key={pf.id}
                  onClick={() => { if (!disabled || active) togglePrimaryFactor(pf.id); }}
                  title={disabled ? `Limit: ${PRIMARY_FACTOR_MAX} factors` : undefined}
                  style={{
                    padding: '10px 12px',
                    background: active ? 'rgba(137, 180, 250, 0.12)' : '#181825',
                    border: `1px solid ${active ? '#89b4fa' : '#313244'}`,
                    borderRadius: 6,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    fontSize: 13,
                    color: active ? '#cdd6f4' : disabled ? '#585b70' : '#a6adc8',
                    fontWeight: active ? 600 : 400,
                    opacity: disabled ? 0.5 : 1,
                    transition: 'all 0.15s',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}
                >
                  <span style={{
                    width: 14, height: 14, borderRadius: 3,
                    border: `1.5px solid ${active ? '#89b4fa' : '#45475a'}`,
                    background: active ? '#89b4fa' : 'transparent',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    color: '#000', fontSize: 10, fontWeight: 800, flexShrink: 0,
                  }}>
                    {active ? '✓' : ''}
                  </span>
                  <span>{pf.label}</span>
                </div>
              );
            })}
          </div>
          {primaryFactors.size > 0 && (
            <textarea
              value={primaryFactorNote}
              onChange={e => setPrimaryFactorNote(e.target.value)}
              placeholder="Briefly explain (optional)…"
              maxLength={400}
              style={{
                width: '100%', marginTop: 10, minHeight: 48,
                background: '#313244', color: '#cdd6f4',
                border: '1px solid #45475a', borderRadius: 6, padding: 8, fontSize: 13,
                resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box',
              }}
            />
          )}
        </div>

        {/* Attention check — appears in both solo and team surveys. The
            prompt tells the respondent exactly which answer to pick, so a
            careful reader always passes. Straight-liners (all 5s, all 3s,
            random) will be flagged for the analyst to drop. */}
        <div style={{
          background: '#1e1e2e', border: '1px solid #313244',
          borderRadius: 12, padding: 20, marginBottom: 16,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
          }}>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '3px 8px',
              borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.05em',
              background: 'rgba(249, 226, 175, 0.15)', color: '#f9e2af',
            }}>
              Quality Check
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4' }}>
              Please read carefully.
            </span>
          </div>
          <div style={{ fontSize: 13, color: '#a6adc8', marginBottom: 10 }}>
            To confirm you are reading the questions, please select <strong>3</strong> for this item.
          </div>
          <LikertScale
            name="attention_check"
            value={attention}
            onChange={setAttention}
          />
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontSize: 10, color: '#45475a', marginTop: 2, padding: '0 4px',
          }}>
            <span>1</span><span>5</span>
          </div>
        </div>

        {/* Open-ended */}
        <div style={{
          background: '#1e1e2e', border: '1px solid #313244',
          borderRadius: 12, padding: 20, marginBottom: 24,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#cdd6f4', marginBottom: 4 }}>
            Open-Ended Feedback
          </div>
          <div style={{ fontSize: 12, color: '#6c7086', marginBottom: 10 }}>
            {isTeam
              ? 'What was the most challenging part of collaborating on this task?'
              : 'What was the most challenging part of working on this task alone?'}
          </div>
          <textarea
            value={challenge}
            onChange={e => setChallenge(e.target.value)}
            placeholder="Consider communication barriers, role constraints, coordination difficulties, or technical gaps... (optional)"
            maxLength={500}
            style={{
              width: '100%', minHeight: 80, background: '#313244', color: '#cdd6f4',
              border: '1px solid #45475a', borderRadius: 8, padding: 10, fontSize: 13,
              resize: 'vertical', fontFamily: 'inherit',
            }}
          />
        </div>

        {/* Submit */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button
            onClick={handleSubmit}
            disabled={!allFilled || submitting}
            style={{
              background: allFilled ? '#6366f1' : '#45475a',
              color: allFilled ? '#fff' : '#6c7086',
              border: 'none', borderRadius: 8, padding: '14px 48px',
              fontWeight: 700, fontSize: 15, cursor: allFilled ? 'pointer' : 'not-allowed',
              transition: 'all 0.2s',
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? 'Submitting...' : allFilled ? 'Submit Survey' : `${totalRequired - totalFilled} ratings remaining`}
          </button>
        </div>

        <p style={{ textAlign: 'center', color: '#45475a', fontSize: 11, marginTop: 12 }}>
          Your responses are stored securely and used only for research purposes.
        </p>
      </div>
    </div>
  );
}
