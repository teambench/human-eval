import { useState, useEffect } from 'react';

export interface OnboardingStep {
  /** CSS selector or position description */
  target: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'center-left' | 'center-right';
  title: string;
  description: string;
}

interface OnboardingProps {
  steps: OnboardingStep[];
  storageKey: string; // localStorage key to remember dismissal
}

const POSITION_MAP: Record<string, React.CSSProperties> = {
  'top-left': { top: 80, left: 24 },
  'top-right': { top: 80, right: 24 },
  'bottom-left': { bottom: 60, left: 24 },
  'bottom-right': { bottom: 60, right: 24 },
  'center': { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' },
  'center-left': { top: '50%', left: 24, transform: 'translateY(-50%)' },
  'center-right': { top: '50%', right: 24, transform: 'translateY(-50%)' },
};

export function Onboarding({ steps, storageKey }: OnboardingProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const seen = localStorage.getItem(storageKey);
    if (seen === 'true') setDismissed(true);
  }, [storageKey]);

  if (dismissed || steps.length === 0) return null;

  const step = steps[currentStep];
  const isLast = currentStep === steps.length - 1;

  const handleNext = () => {
    if (isLast) {
      setDismissed(true);
      localStorage.setItem(storageKey, 'true');
    } else {
      setCurrentStep(s => s + 1);
    }
  };

  const handleSkip = () => {
    setDismissed(true);
    localStorage.setItem(storageKey, 'true');
  };

  return (
    <>
      {/* Overlay */}
      <div
        onClick={handleSkip}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          zIndex: 9998, cursor: 'pointer',
        }}
      />

      {/* Tooltip card */}
      <div style={{
        position: 'fixed', zIndex: 9999,
        ...POSITION_MAP[step.target],
        background: '#1e1e2e', border: '1px solid #6366f1',
        borderRadius: 12, padding: '16px 20px', maxWidth: 340,
        boxShadow: '0 8px 32px rgba(99, 102, 241, 0.3)',
        animation: 'onboardFadeIn 0.3s ease',
      }}>
        {/* Pulse indicator */}
        <div style={{
          position: 'absolute', top: -6, left: 20,
          width: 12, height: 12, borderRadius: '50%',
          background: '#6366f1',
          animation: 'onboardPulse 1.5s infinite',
        }} />

        {/* Step counter */}
        <div style={{
          fontSize: 11, color: '#6366f1', fontWeight: 700,
          marginBottom: 6, letterSpacing: '0.05em',
        }}>
          STEP {currentStep + 1} OF {steps.length}
        </div>

        <div style={{ fontSize: 15, fontWeight: 700, color: '#cdd6f4', marginBottom: 4 }}>
          {step.title}
        </div>
        <div style={{ fontSize: 13, color: '#a6adc8', lineHeight: 1.5, marginBottom: 14 }}>
          {step.description}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            onClick={handleSkip}
            style={{
              background: 'none', border: 'none', color: '#585b70',
              fontSize: 12, cursor: 'pointer', padding: '4px 8px',
            }}
          >
            Skip tour
          </button>
          <button
            onClick={handleNext}
            style={{
              background: '#6366f1', color: '#fff', border: 'none',
              borderRadius: 6, padding: '8px 20px', fontWeight: 700,
              fontSize: 13, cursor: 'pointer',
            }}
          >
            {isLast ? 'Got it!' : 'Next'}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes onboardPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(1.5); }
        }
        @keyframes onboardFadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  );
}

// ── Pre-built step sets for each role ──

export const PLANNER_STEPS: OnboardingStep[] = [
  {
    target: 'center-left',
    title: 'Read the Specification',
    description: 'Start by reading the full task specification on the left panel. Understand every requirement before writing your plan.',
  },
  {
    target: 'center-left',
    title: 'Browse the Files',
    description: 'Switch to the "Files" tab to see the existing codebase. Files are read-only for you — you plan, the Executor implements.',
  },
  {
    target: 'center-right',
    title: 'Communicate with Your Team',
    description: 'Use the chat panel to discuss strategy with your Executor and Verifier. Share key findings from the spec.',
  },
  {
    target: 'bottom-left',
    title: 'Submit Your Plan',
    description: 'When ready, click "Submit Plan & Advance to Execution" to hand off to the Executor. Include specific file changes and priorities.',
  },
];

export const EXECUTOR_STEPS: OnboardingStep[] = [
  {
    target: 'top-left',
    title: 'Wait for the Plan',
    description: 'The Planner is reading the spec and creating a plan. You\'ll see it in the chat. Meanwhile, explore the files to familiarize yourself.',
  },
  {
    target: 'center-left',
    title: 'Edit Files',
    description: 'Once in execution phase, click any file to edit it. You have write access to all workspace files.',
  },
  {
    target: 'bottom-left',
    title: 'Use the Terminal',
    description: 'The terminal connects to a sandboxed environment. Run tests, check syntax, install dependencies — everything you need.',
  },
  {
    target: 'center-right',
    title: 'Chat with Your Team',
    description: 'Ask the Planner for clarification or notify the Verifier when you\'re ready. Communication is key.',
  },
  {
    target: 'top-right',
    title: 'Mark Done',
    description: 'When your implementation is complete, click "Mark Done" to advance to verification. The Verifier will review your work.',
  },
];

export const VERIFIER_STEPS: OnboardingStep[] = [
  {
    target: 'center-left',
    title: 'Review the Specification',
    description: 'Read the full specification carefully. You\'ll use these requirements as your checklist when the Executor is done.',
  },
  {
    target: 'center-left',
    title: 'Inspect the Code',
    description: 'Switch to "Workspace" tab to see all files. Files are read-only — your job is to review, not edit.',
  },
  {
    target: 'center-right',
    title: 'Coordinate via Chat',
    description: 'Ask the Executor questions about their implementation. Provide specific, actionable feedback if something looks wrong.',
  },
  {
    target: 'bottom-left',
    title: 'Submit Your Verdict',
    description: 'Choose PASS or FAIL. If you fail it, write clear notes about what needs fixing — the Executor gets another chance.',
  },
];

export const ORACLE_STEPS: OnboardingStep[] = [
  {
    target: 'center-left',
    title: 'Full Access Mode',
    description: 'You have access to everything: spec, brief, code editor, and terminal. Work at your own pace.',
  },
  {
    target: 'center',
    title: 'Edit & Test',
    description: 'Edit files in the center panel and use the terminal below to run tests and commands.',
  },
  {
    target: 'bottom-left',
    title: 'Submit & Grade',
    description: 'When done, click "Submit & Grade" to auto-grade your solution. You can keep editing and re-submit.',
  },
];
