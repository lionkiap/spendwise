'use client';

/**
 * Goal Planner tab: profile mini-form, goal prompt and the rendered plan.
 *
 * The profile card follows the active space: You and Partner render the same
 * editable form over their own profile, and Us renders a read-only Household
 * profile card with the two personal profiles summed (combineProfiles in
 * goalspec.ts). The prompt and plan flow are identical in every space; only
 * the profile the plan is built on changes.
 *
 * When no take-home figure is stated, the plan below carries an editable
 * assumption chip saying plainly that take-home was estimated from gross minus
 * employee CPF, so nothing about affordability is silently invented.
 */
import { useState } from 'react';

import { employeeCpfContribution } from '../../lib/kernels';
import { PLANNER_DEFAULTS, type GoalSpec, type UserProfile } from '../../lib/planner/goalspec';
import {
  DEFAULT_PROMPT,
  SAVINGS_EXAMPLE_PROMPT,
  fmtMoney,
  type PlanResult,
  type ProfileFormState,
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
  onProfileField,
}: {
  profile: UserProfile;
  space: SpaceId;
  onProfileField: (field: keyof ProfileFormState, raw: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const cpfDeduction = employeeCpfContribution(profile.grossMonthlyIncome);
  const estimated = profile.grossMonthlyIncome - cpfDeduction;
  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed !== '') {
      onProfileField('takeHomeMonthlyIncome', trimmed);
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
  profileForm: ProfileFormState;
  onProfileField: (field: keyof ProfileFormState, raw: string) => void;
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
}

export function PlannerTab({
  space,
  profileForm,
  onProfileField,
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
}: PlannerTabProps) {
  return (
    <div className="stack">
      {space === 'us' ? (
        <section className="card household-card">
          <h2 className="card-title">Household profile</h2>
          <dl className="household-list">
            <div className="household-row">
              <dt>Combined income</dt>
              <dd>
                {fmtMoney(householdProfile.grossMonthlyIncome)}
                <span className="household-unit">/mo</span>
              </dd>
            </div>
            <div className="household-row">
              <dt>Combined expenses</dt>
              <dd>
                {fmtMoney(householdProfile.monthlyExpenses)}
                <span className="household-unit">/mo</span>
              </dd>
            </div>
            <div className="household-row">
              <dt>Take-home income</dt>
              <dd>
                {fmtMoney(
                  householdProfile.takeHomeMonthlyIncome ??
                  householdProfile.grossMonthlyIncome -
                    employeeCpfContribution(householdProfile.grossMonthlyIncome)
                )}
                <span className="household-unit">
                  /mo{householdProfile.takeHomeMonthlyIncome === undefined ? ' (estimated)' : ''}
                </span>
              </dd>
            </div>
            <div className="household-row">
              <dt>Debt repayments</dt>
              <dd>
                {fmtMoney(householdProfile.monthlyDebtCommitments ?? 0)}
                <span className="household-unit">/mo</span>
              </dd>
            </div>
            <div className="household-row">
              <dt>Emergency fund</dt>
              <dd>
                {householdProfile.emergencyReserveMonths ?? PLANNER_DEFAULTS.emergencyReserveMonths}
                <span className="household-unit">
                  {householdProfile.emergencyReserveMonths === undefined ? ' months (default)' : ' months'}
                </span>
              </dd>
            </div>
            <div className="household-row">
              <dt>Liquid savings</dt>
              <dd>{fmtMoney(householdProfile.liquidSavings)}</dd>
            </div>
            <div className="household-row">
              <dt>CPF OA</dt>
              <dd>{fmtMoney(householdProfile.cpfOaBalance)}</dd>
            </div>
            <div className="household-row">
              <dt>Investments</dt>
              <dd>{fmtMoney(householdProfile.investmentsSgd ?? 0)}</dd>
            </div>
          </dl>
          {householdProfile.takeHomeMonthlyIncome === undefined ? (
            <p className="muted source-note">
              Take-home is estimated from gross minus employee CPF: contributions of about 20
              percent of ordinary wages, up to the S$6,000 wage ceiling, are deducted from combined
              gross pay, because that money never reaches the account the saving must come from.
              Both of you stating a take-home figure in your own spaces replaces the estimate with
              the sum. Plans built here carry the same honest note as an assumption chip.
            </p>
          ) : null}
          <p className="muted source-note household-note">
            Edit each person&rsquo;s numbers in their own space; this card always shows the sum.
          </p>
        </section>
      ) : (
        <section className="card">
          <h2 className="card-title">{space === 'partner' ? 'Partner&rsquo;s profile' : 'Your profile'}</h2>
          <div className="field-row">
            <label className="field">
              <span>Age</span>
              <input
                type="number"
                min={16}
                max={80}
                value={profileForm.age}
                onChange={(event) => onProfileField('age', event.target.value)}
              />
            </label>
            <label className="field">
              <span>Gross monthly income (S$)</span>
              <input
                type="number"
                min={0}
                step={100}
                value={profileForm.grossMonthlyIncome}
                onChange={(event) => onProfileField('grossMonthlyIncome', event.target.value)}
              />
            </label>
            <label className="field">
              <span>Monthly expenses (S$)</span>
              <input
                type="number"
                min={0}
                step={100}
                value={profileForm.monthlyExpenses}
                onChange={(event) => onProfileField('monthlyExpenses', event.target.value)}
              />
            </label>
            <label className="field">
              <span>Liquid savings (S$)</span>
              <input
                type="number"
                min={0}
                step={500}
                value={profileForm.liquidSavings}
                onChange={(event) => onProfileField('liquidSavings', event.target.value)}
              />
            </label>
            <label className="field">
              <span>CPF OA balance (S$)</span>
              <input
                type="number"
                min={0}
                step={500}
                value={profileForm.cpfOaBalance}
                onChange={(event) => onProfileField('cpfOaBalance', event.target.value)}
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Investments (S$, optional)</span>
              <input
                type="number"
                min={0}
                step={500}
                value={profileForm.investmentsSgd}
                placeholder="0"
                onChange={(event) => onProfileField('investmentsSgd', event.target.value)}
              />
            </label>
            <label className="field">
              <span>Expected return (% p.a., optional)</span>
              <input
                type="number"
                min={0}
                step={0.25}
                value={profileForm.investmentRatePct}
                placeholder="4.5"
                onChange={(event) => onProfileField('investmentRatePct', event.target.value)}
              />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Take-home income (S$, leave empty to estimate from gross minus CPF)</span>
              <input
                type="number"
                min={0}
                step={50}
                value={profileForm.takeHomeMonthlyIncome}
                placeholder="estimated"
                onChange={(event) => onProfileField('takeHomeMonthlyIncome', event.target.value)}
              />
            </label>
            <label className="field">
              <span>
                Monthly debt repayments (S$, enter only commitments not already inside monthly
                expenses)
              </span>
              <input
                type="number"
                min={0}
                step={50}
                value={profileForm.monthlyDebtCommitments}
                placeholder="0"
                onChange={(event) => onProfileField('monthlyDebtCommitments', event.target.value)}
              />
            </label>
            <label className="field">
              <span>Emergency fund (months, optional)</span>
              <input
                type="number"
                min={0}
                step={1}
                value={profileForm.emergencyReserveMonths}
                placeholder="3"
                onChange={(event) => onProfileField('emergencyReserveMonths', event.target.value)}
              />
            </label>
          </div>
          <p className="muted source-note">
            An investment portfolio is credited toward the goal first and grows at its own rate;
            leave the fields empty to plan on cash alone. Take-home pay, debt repayments and the
            emergency fund shape the affordability verdict: with no take-home stated, employee CPF
            contributions of about 20 percent up to the S$6,000 wage ceiling are deducted from
            gross pay before the surplus is measured.
          </p>
        </section>
      )}

      <section className="card">
        <h2 className="card-title">Your goal</h2>
        <label className="field">
          <span>Describe your goal in plain English</span>
          <textarea
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
              onProfileField={onProfileField}
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
