'use client';

/**
 * The Dashboard: the landing view of the sidebar shell and the main
 * experience of the app. The selected goal takes the dominant position
 * (about two thirds of the width on desktop) with its balance as the
 * largest figure on screen, a tall trajectory chart, status, dates, a
 * compact summary strip and Log savings as the primary action. The side
 * column carries the goal composer (the same creation flow the header's
 * New goal button opens) and a contextual adviser whose suggestions carry
 * the selected goal into the Adviser view. Other goals sit below as
 * compact cards; each space remembers its own selection.
 *
 * Every figure comes from the pure functions in src/lib/planner: the hero
 * reads actualBalance, progressRatio, paceStatus and monthsToTarget, and the
 * composer preview rebuilds through buildPlan and fillAssumptions exactly as
 * the planner route does. The model is never involved.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { buildPlan, type PlanJSON } from '../../lib/planner/build';
import type { GoalSpec, UserProfile } from '../../lib/planner/goalspec';
import { fillAssumptions } from '../../lib/planner/parse';
import {
  actualBalance,
  actualPace,
  chartSeries,
  monthKeyDiff,
  monthsToTarget,
  paceStatus,
  progressRatio,
  type TrackedGoal,
} from '../../lib/planner/progress';

import { TrajectoryChart } from './dashboard-tab';
import {
  GOAL_TEMPLATES,
  fmtMoney,
  type PlanResult,
  type SpaceId,
  type ViewId,
} from './shared';

export interface DashboardViewProps {
  space: SpaceId;
  goals: TrackedGoal[];
  profile: UserProfile;
  monthKey: string;
  /** The featured goal's id, resolved by the page through pickSelectedGoal. */
  selectedGoalId: string | null;
  onSelectGoal: (id: string) => void;
  planning: boolean;
  planError: string | null;
  planResult: PlanResult | null;
  /** The composer's Build my plan: runs the shared planner pipeline. */
  onBuildPlan: (text: string) => void;
  /** The composer's Save and track: appends the preview pair as a goal. */
  onTrackFromPreview: (spec: GoalSpec, plan: PlanJSON) => void;
  /** A contextual suggestion, carried into the Adviser view. */
  onAskAdviser: (question: string) => void;
  /** Bumped by the header's New goal button to open and focus the composer. */
  focusComposerSignal: number;
  onDeleteGoal: (goal: TrackedGoal) => void;
  onLogSavings: (
    goal: TrackedGoal,
    monthKey: string,
    contributedSgd: number,
    note: string,
    contributor: 'you' | 'partner'
  ) => void;
  onDeleteLog: (goal: TrackedGoal, logMonthKey: string, contributor: 'you' | 'partner') => void;
  onNavigate: (view: ViewId) => void;
}

export function DashboardView({
  space,
  goals,
  profile,
  monthKey,
  selectedGoalId,
  onSelectGoal,
  planning,
  planError,
  planResult,
  onBuildPlan,
  onTrackFromPreview,
  onAskAdviser,
  focusComposerSignal,
  onDeleteGoal,
  onLogSavings,
  onDeleteLog,
  onNavigate,
}: DashboardViewProps) {
  const selected = useMemo(
    () => goals.find((goal) => goal.id === selectedGoalId) ?? null,
    [goals, selectedGoalId]
  );
  const others = useMemo(
    () => goals.filter((goal) => goal.id !== selectedGoalId),
    [goals, selectedGoalId]
  );

  if (goals.length === 0) {
    return (
      <div className="stack" id="view-dashboard">
        <div className="view-head">
          <h1 className="view-title">Dashboard</h1>
        </div>
        <EmptyDashboard
          planning={planning}
          planError={planError}
          planResult={planResult}
          profile={profile}
          onBuildPlan={onBuildPlan}
          onTrackFromPreview={onTrackFromPreview}
          focusComposerSignal={focusComposerSignal}
        />
      </div>
    );
  }

  return (
    <div className="stack" id="view-dashboard">
      <div className="view-head">
        <h1 className="view-title">Dashboard</h1>
      </div>
      <div className="dash-grid">
        <div className="dash-main stack">
          {selected !== null ? (
            <GoalHero
              goal={selected}
              space={space}
              monthKey={monthKey}
              onLogSavings={onLogSavings}
              onDeleteGoal={onDeleteGoal}
              onAdjustPlan={() => onNavigate('goals')}
              onAskAdviser={onAskAdviser}
            />
          ) : null}
          {others.length > 0 ? (
            <OtherGoalCards goals={others} monthKey={monthKey} onSelectGoal={onSelectGoal} />
          ) : null}
        </div>
        <div className="dash-side stack">
          <GoalComposer
            planning={planning}
            planError={planError}
            planResult={planResult}
            profile={profile}
            onBuildPlan={onBuildPlan}
            onTrackFromPreview={onTrackFromPreview}
            focusComposerSignal={focusComposerSignal}
          />
          {selected !== null ? (
            <ContextualAdviser goal={selected} onAskAdviser={onAskAdviser} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Empty dashboard: creation is the focal point                        */
/* ------------------------------------------------------------------ */

function EmptyDashboard({
  planning,
  planError,
  planResult,
  onBuildPlan,
  onTrackFromPreview,
  focusComposerSignal,
}: {
  planning: boolean;
  planError: string | null;
  planResult: PlanResult | null;
  profile: UserProfile;
  onBuildPlan: (text: string) => void;
  onTrackFromPreview: (spec: GoalSpec, plan: PlanJSON) => void;
  focusComposerSignal: number;
}) {
  return (
    <div className="dash-empty-state">
      <div className="dash-empty-copy">
        <h2 className="dash-empty-title">What are you saving towards?</h2>
        <p className="muted">
          Describe a goal in one sentence and SpendWise compiles it into a full deterministic
          plan: the target, the monthly saving it takes, the timeline and every assumption it
          had to make. Track it and this dashboard follows your progress month by month.
        </p>
        <p className="muted">
          The sidebar&rsquo;s <span className="strong">Try the sample journey</span> action can
          also seed a demo household, kept strictly separate from anything you type here.
        </p>
      </div>
      <GoalComposer
        planning={planning}
        planError={planError}
        planResult={planResult}
        variant="hero"
        onBuildPlan={onBuildPlan}
        onTrackFromPreview={onTrackFromPreview}
        focusComposerSignal={focusComposerSignal}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Goal composer: the shared creation flow                             */
/* ------------------------------------------------------------------ */

/** Which figure of the spec a goal kind carries as its target. */
function specTargetOf(spec: GoalSpec): number {
  if (spec.kind === 'property_purchase') {
    return spec.targetPriceSgd;
  }
  if (spec.kind === 'car_purchase') {
    return spec.priceSgd;
  }
  return spec.targetAmountSgd;
}

function withSpecTarget(spec: GoalSpec, target: number): GoalSpec {
  if (spec.kind === 'property_purchase') {
    return { ...spec, targetPriceSgd: target };
  }
  if (spec.kind === 'car_purchase') {
    return { ...spec, priceSgd: target };
  }
  return { ...spec, targetAmountSgd: target };
}

function GoalComposer({
  planning,
  planError,
  planResult,
  profile,
  variant = 'side',
  onBuildPlan,
  onTrackFromPreview,
  focusComposerSignal,
}: {
  planning: boolean;
  planError: string | null;
  planResult: PlanResult | null;
  profile?: UserProfile;
  variant?: 'side' | 'hero';
  onBuildPlan: (text: string) => void;
  onTrackFromPreview: (spec: GoalSpec, plan: PlanJSON) => void;
  focusComposerSignal: number;
}) {
  const [text, setText] = useState('');
  const [awaiting, setAwaiting] = useState(false);
  const [openOnMobile, setOpenOnMobile] = useState(false);
  const [editTarget, setEditTarget] = useState('');
  const [editDeadline, setEditDeadline] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (focusComposerSignal > 0) {
      setOpenOnMobile(true);
      const timer = window.setTimeout(() => textareaRef.current?.focus(), 120);
      return () => window.clearTimeout(timer);
    }
  }, [focusComposerSignal]);

  // The stage reacts to the shared plan result only while this composer
  // submitted the text (the Goals view plans independently).
  const spec = awaiting && planResult !== null ? planResult.goalSpec : undefined;
  useEffect(() => {
    if (spec === undefined) {
      return;
    }
    setEditTarget(String(specTargetOf(spec)));
    setEditDeadline(String(spec.deadlineAge > 0 ? spec.deadlineAge : ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  const missingTiming = spec !== undefined && spec.deadlineAge <= 0;
  const missingAmount = spec !== undefined && specTargetOf(spec) <= 0;
  const clarify = spec !== undefined && (missingTiming || missingAmount);

  const editedSpec = useMemo<GoalSpec | null>(() => {
    if (spec === undefined) {
      return null;
    }
    const target = Number(editTarget);
    const deadline = Number(editDeadline);
    if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(deadline) || deadline <= 0) {
      return null;
    }
    return withSpecTarget({ ...spec, deadlineAge: Math.round(deadline) }, Math.round(target));
  }, [spec, editTarget, editDeadline]);

  const previewPlan = useMemo<PlanJSON | null>(() => {
    if (editedSpec === null || profile === undefined) {
      return null;
    }
    return buildPlan(editedSpec, profile, fillAssumptions(editedSpec, profile));
  }, [editedSpec, profile]);

  function submit(): void {
    const trimmed = text.trim();
    if (trimmed === '') {
      return;
    }
    setAwaiting(true);
    onBuildPlan(trimmed);
  }

  function backToCompose(): void {
    setAwaiting(false);
    window.setTimeout(() => textareaRef.current?.focus(), 60);
  }

  const showPreview = awaiting && spec !== undefined && !clarify && previewPlan !== null;

  return (
    <section
      className={`card dash-composer ${variant === 'hero' ? 'dash-composer-hero' : ''} ${
        openOnMobile ? 'composer-open' : ''
      }`}
      aria-label="Create a goal"
    >
      {variant === 'side' ? (
        <button
          type="button"
          className="btn btn-ghost btn-small composer-close"
          aria-label="Close goal creation"
          onClick={() => setOpenOnMobile(false)}
        >
          Close
        </button>
      ) : null}
      <label className="field" htmlFor="dash-composer-text">
        <span className="composer-label">What are you saving towards?</span>
        <textarea
          id="dash-composer-text"
          ref={textareaRef}
          className="prompt-box"
          rows={variant === 'hero' ? 3 : 2}
          value={text}
          placeholder="I want to save S$30,000 for our wedding in three years."
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
      </label>
      <div className="chip-row">
        {GOAL_TEMPLATES.map((template) => (
          <button
            key={template.label}
            type="button"
            className="example-chip"
            onClick={() => {
              setText(template.prefill);
              setAwaiting(false);
              textareaRef.current?.focus();
            }}
          >
            {template.label}
          </button>
        ))}
      </div>

      {awaiting && planError !== null ? (
        <p className="error-banner" role="alert">
          {planError}
        </p>
      ) : null}

      {clarify ? (
        <div className="composer-clarify">
          <h3 className="section-subtitle">A little more information</h3>
          <ul className="dash-clarify-list">
            {missingAmount ? (
              <li>How much money does this goal need? Add an amount, for example &ldquo;30k&rdquo;.</li>
            ) : null}
            {missingTiming ? (
              <li>By when? Add an age or a timeframe, for example &ldquo;by age 30&rdquo; or &ldquo;in 3 years&rdquo;.</li>
            ) : null}
          </ul>
          <p className="muted">Edit your sentence above and build the plan again.</p>
        </div>
      ) : null}

      {showPreview && editedSpec !== null && previewPlan !== null ? (
        <div className="composer-preview">
          <h3 className="section-subtitle">Your plan preview</h3>
          <div className="field-row">
            <label className="field">
              <span>Target (S$)</span>
              <input
                type="number"
                min={100}
                step={500}
                value={editTarget}
                onChange={(event) => setEditTarget(event.target.value)}
              />
            </label>
            <label className="field">
              <span>By age</span>
              <input
                type="number"
                min={profile?.age ?? 16}
                max={80}
                value={editDeadline}
                onChange={(event) => setEditDeadline(event.target.value)}
              />
            </label>
          </div>
          <div className="composer-preview-facts">
            <p className="composer-preview-line">
              <span className="composer-fact-label">Monthly saving</span>
              <span className="composer-fact-value">
                {fmtMoney(previewPlan.requiredMonthlySavings)}
              </span>
            </p>
            <p className="composer-preview-line">
              <span className="composer-fact-label">Verdict</span>
              <span className="composer-fact-value">{previewPlan.verdict.headline}</span>
            </p>
            <p className="composer-preview-line">
              <span className="composer-fact-label">Assumptions</span>
              <span className="composer-fact-value">
                {previewPlan.assumptions.length} filled, shown as chips after tracking
              </span>
            </p>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onTrackFromPreview(editedSpec, previewPlan)}
            >
              Save and track this goal
            </button>
            <button type="button" className="btn btn-ghost" onClick={backToCompose}>
              Edit the sentence
            </button>
          </div>
        </div>
      ) : null}

      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={submit} disabled={planning}>
          {planning && awaiting ? 'Building...' : 'Build my plan'}
        </button>
        {awaiting && spec === undefined && planError === null && planning ? (
          <span className="muted form-hint">Running the deterministic kernels...</span>
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* The selected goal's dominant panel                                  */
/* ------------------------------------------------------------------ */

function statusOf(goal: TrackedGoal, elapsed: number): {
  label: string;
  tone: 'ahead' | 'on' | 'behind' | 'unknown';
} {
  if (elapsed === 0 || goal.logs.length === 0) {
    return { label: 'Needs more information', tone: 'unknown' };
  }
  const status = paceStatus(goal, elapsed);
  if (status === 'ahead') {
    return { label: 'Ahead', tone: 'ahead' };
  }
  if (status === 'behind') {
    return { label: 'Behind', tone: 'behind' };
  }
  return { label: 'On track', tone: 'on' };
}

function GoalHero({
  goal,
  space,
  monthKey,
  onLogSavings,
  onDeleteGoal,
  onAdjustPlan,
  onAskAdviser,
}: {
  goal: TrackedGoal;
  space: SpaceId;
  monthKey: string;
  onLogSavings: DashboardViewProps['onLogSavings'];
  onDeleteGoal: (goal: TrackedGoal) => void;
  onAdjustPlan: () => void;
  onAskAdviser: (question: string) => void;
}) {
  const [logOpen, setLogOpen] = useState(false);
  const elapsed = Math.max(0, monthKeyDiff(goal.startMonthKey, monthKey));
  const status = statusOf(goal, elapsed);
  const balance = actualBalance(goal, elapsed);
  const ratio = progressRatio(goal, elapsed);
  const pace = actualPace(goal, elapsed);
  const finishMonths =
    pace > 0 ? monthsToTarget(goal.startSavingsSgd, goal.ratePa, pace, goal.targetSgd) : null;
  const finishAge = finishMonths === null ? null : goal.startAge + Math.ceil(finishMonths / 12);
  const gap = Math.max(0, goal.targetSgd - balance);
  const savedThisMonth = goal.logs
    .filter((log) => log.monthKey === monthKey)
    .reduce((sum, log) => sum + log.contributedSgd, 0);

  return (
    <section className="goal-hero" aria-label={`Goal ${goal.name}`}>
      <header className="goal-hero-head">
        <div>
          <h2 className="goal-hero-name">{goal.name}</h2>
          <p className="goal-hero-sub muted">
            {goal.goalSpec.kind === 'property_purchase'
              ? `Cash target toward a ${fmtMoney(goal.goalSpec.targetPriceSgd)} home`
              : `Target ${fmtMoney(goal.targetSgd)}`}
            {' · '}by age {goal.deadlineAge}
            {finishAge !== null
              ? finishAge <= goal.deadlineAge
                ? ` · at this pace age ${finishAge}`
                : ` · at this pace age ${finishAge}`
              : ' · pace unknown yet'}
          </p>
        </div>
        <div className="goal-hero-tools">
          <span className={`goal-status goal-status-${status.tone}`}>{status.label}</span>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => onDeleteGoal(goal)}
          >
            Stop tracking
          </button>
        </div>
      </header>

      <div className="goal-hero-figures">
        <div className="goal-hero-figure-block">
          <span className="hero-figure">{fmtMoney(balance)}</span>
          <span className="hero-figure-sub">
            saved of {fmtMoney(goal.targetSgd)} · {Math.round(ratio * 100)}%
          </span>
        </div>
        <div
          className="goal-hero-progress"
          role="progressbar"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${Math.round(ratio * 100)} percent of the target`}
        >
          <div className="goal-hero-progress-fill" style={{ width: `${ratio * 100}%` }} />
        </div>
      </div>

      <figure className="chart goal-hero-chart">
        <TrajectoryChart goal={goal} elapsed={elapsed} revealed height={330} />
        <ChartTableAlt goal={goal} elapsed={elapsed} />
      </figure>

      <div className="goal-hero-summary">
        <div className="goal-hero-fact">
          <span className="goal-fact-label">Saved this month</span>
          <span className="goal-fact-value">{fmtMoney(savedThisMonth)}</span>
        </div>
        <div className="goal-hero-fact">
          <span className="goal-fact-label">Planned monthly</span>
          <span className="goal-fact-value">{fmtMoney(goal.requiredMonthlySgd)}</span>
        </div>
        <div className="goal-hero-fact">
          <span className="goal-fact-label">Remaining gap</span>
          <span className="goal-fact-value">{fmtMoney(gap)}</span>
        </div>
      </div>

      <div className="goal-hero-actions">
        <button
          type="button"
          className="btn btn-primary goal-hero-primary"
          onClick={() => setLogOpen((previous) => !previous)}
        >
          Log savings
        </button>
        <button type="button" className="btn btn-secondary" onClick={onAdjustPlan}>
          Adjust the plan
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => onAskAdviser(`Am I on track for "${goal.name}"?`)}
        >
          Ask the adviser
        </button>
      </div>

      {logOpen ? (
        <InlineLogForm
          goal={goal}
          space={space}
          monthKey={monthKey}
          onSaved={() => setLogOpen(false)}
          onLogSavings={onLogSavings}
        />
      ) : null}
    </section>
  );
}

function InlineLogForm({
  goal,
  space,
  monthKey,
  onSaved,
  onLogSavings,
}: {
  goal: TrackedGoal;
  space: SpaceId;
  monthKey: string;
  onSaved: () => void;
  onLogSavings: DashboardViewProps['onLogSavings'];
}) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [contributor, setContributor] = useState<'you' | 'partner'>('you');

  function save(): void {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0 || !/^\d{4}-\d{2}$/.test(monthKey)) {
      return;
    }
    onLogSavings(goal, monthKey, Math.round(parsed * 100) / 100, note.trim(), contributor);
    setAmount('');
    setNote('');
    onSaved();
  }

  return (
    <div className="goal-hero-log">
      <h3 className="section-subtitle">Log {monthKey === '' ? 'this month' : monthKey}</h3>
      <div className="field-row">
        <label className="field">
          <span>Amount saved (S$)</span>
          <input
            type="number"
            min={0}
            step={50}
            value={amount}
            placeholder={String(Math.round(goal.requiredMonthlySgd))}
            onChange={(event) => setAmount(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                save();
              }
            }}
          />
        </label>
        <label className="field">
          <span>Note (optional)</span>
          <input
            type="text"
            value={note}
            placeholder="bonus, side income..."
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {space === 'us' ? (
          <div className="field">
            <span>Logged by</span>
            <div className="pill-row">
              <button
                type="button"
                className={`btn btn-small ${contributor === 'you' ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={contributor === 'you'}
                onClick={() => setContributor('you')}
              >
                You
              </button>
              <button
                type="button"
                className={`btn btn-small ${contributor === 'partner' ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={contributor === 'partner'}
                onClick={() => setContributor('partner')}
              >
                Partner
              </button>
            </div>
          </div>
        ) : null}
        <div className="field">
          <span aria-hidden="true">&nbsp;</span>
          <button type="button" className="btn btn-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
      <p className="muted form-hint">
        One entry per contributor per month: saving the same month again corrects that
        person&rsquo;s figure.
      </p>
    </div>
  );
}

/** The chart's data-table alternative, collapsed by default. */
function ChartTableAlt({ goal, elapsed }: { goal: TrackedGoal; elapsed: number }) {
  const series = useMemo(() => chartSeries(goal, elapsed, 14), [goal, elapsed]);
  const actualByMonth = new Map(series.actual.map((point) => [point.month, point.balance]));
  return (
    <details className="chart-table-alt">
      <summary>View the chart as a table</summary>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Age</th>
              <th scope="col">Planned</th>
              <th scope="col">Actual</th>
            </tr>
          </thead>
          <tbody>
            {series.planned.map((point) => (
              <tr key={point.month}>
                <td>{point.month}</td>
                <td>{goal.startAge + Math.round(point.month / 12)}</td>
                <td className="money">{fmtMoney(point.balance)}</td>
                <td className="money">
                  {actualByMonth.has(point.month)
                    ? fmtMoney(actualByMonth.get(point.month) ?? 0)
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* Contextual adviser and the other-goal cards                         */
/* ------------------------------------------------------------------ */

const CONTEXT_SUGGESTIONS: ReadonlyArray<string> = [
  'Am I on track?',
  'How can I reach this sooner?',
  'What if I save another 200 monthly?',
];

function ContextualAdviser({
  goal,
  onAskAdviser,
}: {
  goal: TrackedGoal;
  onAskAdviser: (question: string) => void;
}) {
  return (
    <section className="card dash-adviser" aria-label="Adviser suggestions">
      <h2 className="card-title">Ask about this goal</h2>
      <p className="muted">
        Questions open the Adviser with <span className="strong">{goal.name}</span> selected, in
        this space&rsquo;s own conversation.
      </p>
      <div className="stack">
        {CONTEXT_SUGGESTIONS.map((question) => (
          <button
            key={question}
            type="button"
            className="btn btn-secondary dash-suggestion"
            onClick={() => onAskAdviser(question)}
          >
            {question}
          </button>
        ))}
      </div>
    </section>
  );
}

function OtherGoalCards({
  goals,
  monthKey,
  onSelectGoal,
}: {
  goals: TrackedGoal[];
  monthKey: string;
  onSelectGoal: (id: string) => void;
}) {
  return (
    <section className="dash-others" aria-label="Other goals">
      <h2 className="section-subtitle">Other goals in this space</h2>
      <div className="dash-others-row">
        {goals.map((goal) => {
          const elapsed = Math.max(0, monthKeyDiff(goal.startMonthKey, monthKey));
          const ratio = progressRatio(goal, elapsed);
          const status = statusOf(goal, elapsed);
          return (
            <button
              key={goal.id}
              type="button"
              className="dash-goal-card"
              onClick={() => onSelectGoal(goal.id)}
            >
              <span className="dash-goal-card-name">{goal.name}</span>
              <span className={`goal-status goal-status-${status.tone}`}>{status.label}</span>
              <span className="dash-goal-card-pct">{Math.round(ratio * 100)}% of target</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
