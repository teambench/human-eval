import { useState } from 'react';
import { ref, set } from 'firebase/database';
import { db } from '../firebase';
import { Role, SessionMode } from '../types';

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
    label: 'Help with implementation (Executor role)',
    prompt: 'A second person to pair-program or suggest code would have been valuable on this task.',
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

export function SurveyView({ sessionId, taskId, role, mode, participants, onComplete }: SurveyViewProps) {
  const isTeam = mode === 'team';

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

  const [ratings, setRatings] = useState<Record<string, Record<string, number>>>({});
  // ── Solo-mode state ──
  const [taskItems, setTaskItems] = useState<Record<string, number>>({});
  const [counterfactual, setCounterfactual] = useState<Record<string, number>>({});

  const [challenge, setChallenge] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const setRating = (targetId: string, dimId: string, value: number) => {
    setRatings(prev => ({
      ...prev,
      [targetId]: { ...prev[targetId], [dimId]: value },
    }));
  };

  // Validation
  let totalRequired = 0;
  let totalFilled = 0;
  if (isTeam) {
    totalRequired = targets.length * DIMENSIONS.length;
    totalFilled = Object.values(ratings).reduce((sum, dims) => sum + Object.keys(dims).length, 0);
  } else {
    totalRequired = SOLO_TASK_ITEMS.length + SOLO_COUNTERFACTUAL.length;
    totalFilled = Object.keys(taskItems).length + Object.keys(counterfactual).length;
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
        schema_version: '1.1',
        instrument: 'CATME-lite',
        reference: 'Ohland et al. (2012) Academy of Management Learning & Education 11(4)',
        timestamp: Date.now(),
        timestampISO: new Date().toISOString(),
        sessionId, taskId, mode,
        respondentRole: role,
        peerRatings, selfRating,
        openEnded: { collaborationChallenge: challenge },
      };
    } else {
      surveyData = {
        schema_version: '1.1',
        instrument: 'TeamBench-Solo-Reflection',
        reference: 'NASA-TLX (Hart & Staveland, 1988) + CATME counterfactual',
        timestamp: Date.now(),
        timestampISO: new Date().toISOString(),
        sessionId, taskId, mode,
        respondentRole: role,
        taskExperience: taskItems,                  // difficulty/effort/pressure/confidence
        counterfactualTeamValue: counterfactual,    // CATME dims rated as "would have helped"
        openEnded: { collaborationChallenge: challenge },
      };
    }

    try {
      await set(ref(db, `teambench/sessions/${sessionId}/survey/${role}`), surveyData);
    } catch (err) {
      console.error('Failed to save survey:', err);
    }

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
                  onChange={v => setTaskItems(prev => ({ ...prev, [item.id]: v }))}
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
        {!isTeam && (
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
                  onChange={v => setCounterfactual(prev => ({ ...prev, [item.id]: v }))}
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

            {/* Dimensions */}
            {DIMENSIONS.map((dim, i) => (
              <div key={dim.id} style={{
                paddingBottom: i < DIMENSIONS.length - 1 ? 16 : 0,
                marginBottom: i < DIMENSIONS.length - 1 ? 16 : 0,
                borderBottom: i < DIMENSIONS.length - 1 ? '1px solid #313244' : 'none',
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
                  onChange={v => setRating(target.id, dim.id, v)}
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
          </div>
        ))}

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
