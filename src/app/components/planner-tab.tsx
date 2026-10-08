'use client';

/**
 * Goal Planner: the goal prompt, the rendered plan and the what-if advisor.
 *
 * The per-space profile form and the read-only Us household card moved to the
 * ProfileDrawer (opened from the sidebar's Edit profile button); this view
 * keeps everything that acts on a plan. When no take-home figure is stated,
 * the plan below carries an editable assumption chip saying plainly that
 * take-home was estimated from gross minus employee CPF, so nothing about
 * affordability is silently invented.
 */
import { useEffect, useRef, useState } from 'react';

import { employeeCpfContribution } from '../../lib/kernels';
import type { GoalSpec, UserProfile } from '../../lib/planner/goalspec';
import {
  DEFAULT_PROMPT,
  SAVINGS_EXAMPLE_PROMPT,
  fmtMoney,
  type PlanResult,
  type SpaceId,
  type StatusJson,
} from './shared';
import { PlanView } from './plan-view';
import { AdvisorCard } from './advisor-card';

/**
 * The editable take-home assumption chip, shown with a rendered plan whenever
 * the planning profile states no take-home figure. The estimate itself is the
 * same deterministic kernel the affordability verdict uses (gross minus
 * employeeCpfContribution), so the chip never invents a number the plan did
 * not already compute; the input lets the user replace the estimate with their
 * actual take-home, which makes the stated figure win on the next plan. In the
 * Us space nothing is editable (the household figure is the sum of two
 * personal figures), so the chip just says where to state it.
 */
function TakeHomeAssumptionChip({
  profile,
  space,
  onTakeHomeCommit,
}: {
  profile: UserProfile;
  space: SpaceId;
  onTakeHomeCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const cpfDeduction = employeeCpfContribution(profile.grossMonthlyIncome);
  const estimated = profile.grossMonthlyIncome - cpfDeduction;
  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed !== '') {
      onTakeHomeCommit(trimmed);
    }
  };
  return (
    <section className="card" aria-label="Take-home pay assumption">
      <h3 className="card-title">Assumption applied to this plan</h3>
      <div className="chip-row">
        <div className="assumption-chip takehome-chip" title="takeHomeMonthlyIncome">
          <span className="assumption-value">
            Take-home estimated from gross minus employee CPF: {fmtMoney(estimated)}/mo
          </span>
          <span className="assumption-reason">
            You have not stated a take-home figure, so employee CPF contributions of{' '}
            {fmtMoney(cpfDeduction)} (20 percent of ordinary wages, up to the S$6,000 ceiling) are
            deducted from gross pay of {fmtMoney(profile.grossMonthlyIncome)} before the surplus is
            measured. State your actual take-home to replace the estimate.
          </span>
          {space === 'us' ? (
            <span className="assumption-reason">
              The household take-home becomes stated only when both partners state their own figure
              in the You and Partner spaces; until then this estimate is what every Us plan uses.
            </span>
          ) : (
            <form
              className="takehome-edit"
              onSubmit={(event) => {
                event.preventDefault();
                commit();
              }}
            >
              <label className="takehome-edit-label" htmlFor="takehome-override-input">
                Actual take-home (S$/mo)
              </label>
              <input
                id="takehome-override-input"
                type="number"
                min={0}
                step={50}
                value={draft}
                placeholder={String(Math.round(estimated))}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
              />
              <button type="submit" className="btn btn-secondary btn-small">
                Use this figure
              </button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}

interface PlannerTabProps {
  space: SpaceId;
  /** The planning profile of the space: personal in You and Partner, combined in Us. */
  householdProfile: UserProfile;
  prompt: string;
  onPromptChange: (value: string) => void;
  planning: boolean;
  planError: string | null;
  planResult: PlanResult | null;
  onPlan: () => void;
  onTrackGoal: () => void;
  /** Connection truth from /api status, for the advisor's engine badge. */
  connection: StatusJson['connection'] | null;
  /** Apply an advisor revision to the planner state. */
  onApplyRevision: (goalSpec: GoalSpec, profile: UserProfile) => void;
  /**
   * Commit a user-stated take-home figure for the active person (the
   * assumption chip's override), routed to the same profile setter the
   * drawer's form uses.
   */
  onTakeHomeCommit: (value: string) => void;
  /**
   * Bumped by the header's New goal button: each bump (after the first)
   * focuses the goal prompt textarea. A counter, not a boolean, so two
   * consecutive presses both land.
   */
  focusPromptSignal: number;
}

export function PlannerTab({
  space,
  householdProfile,
  prompt,
  onPromptChange,
  planning,
  planError,
  planResult,
  onPlan,
  onTrackGoal,
  connection,
  onApplyRevision,
  onTakeHomeCommit,
  focusPromptSignal,
}: PlannerTabProps) {
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (focusPromptSignal > 0) {
      promptRef.current?.focus();
    }
  }, [focusPromptSignal]);

  return (
    <div className="stack">
      <section className="card">
        <h2 className="card-title">Your goal</h2>
        <label className="field">
          <span>Describe your goal in plain English</span>
          <textarea
            ref={promptRef}
            className="prompt-box"
            rows={3}
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            placeholder={DEFAULT_PROMPT}
          />
        </label>
        <div className="chip-row">
          <button
            type="button"
            className="example-chip"
            onClick={() => onPromptChange(SAVINGS_EXAMPLE_PROMPT)}
          >
            Example: save 1 million by 50 at 1.8 percent pa
          </button>
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={onPlan} disabled={planning}>
            {planning ? 'Planning...' : 'Plan'}
          </button>
          <span className="muted form-hint">
            Unstated numbers are filled by snapshot assumptions shown as chips in the plan.
          </span>
        </div>
        {planning ? <p className="loading">Running the deterministic kernels...</p> : null}
        {planError !== null ? (
          <p className="error-banner" role="alert">
            {planError}
          </p>
        ) : null}
      </section>

      {planResult !== null ? (
        <>
          <PlanView result={planResult} />
          {householdProfile.takeHomeMonthlyIncome === undefined ? (
            <TakeHomeAssumptionChip
              profile={householdProfile}
              space={space}
              onTakeHomeCommit={onTakeHomeCommit}
            />
          ) : null}
          {planResult.goalSpec !== undefined ? (
            <div className="track-row">
              <p className="muted">
                Track this goal to log what you save each month and watch your trajectory against
                this plan on the Progress dashboard.
              </p>
              <button type="button" className="btn btn-secondary" onClick={onTrackGoal}>
                Track this goal
              </button>
            </div>
          ) : null}
          {planResult.goalSpec !== undefined ? (
            <AdvisorCard
              space={space}
              goalSpec={planResult.goalSpec}
              profile={householdProfile}
              connection={connection}
              onApplyRevision={onApplyRevision}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
