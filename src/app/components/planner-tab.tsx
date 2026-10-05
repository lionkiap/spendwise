'use client';

/**
 * Goal Planner tab: profile mini-form, goal prompt and the rendered plan.
 *
 * The profile card follows the active space: You and Partner render the same
 * editable form over their own profile, and Us renders a read-only Household
 * profile card with the two personal profiles summed (combineProfiles in
 * goalspec.ts). The prompt and plan flow are identical in every space; only
 * the profile the plan is built on changes.
 */
import type { UserProfile } from '../../lib/planner/goalspec';
import {
  DEFAULT_PROMPT,
  SAVINGS_EXAMPLE_PROMPT,
  fmtMoney,
  type PlanResult,
  type ProfileFormState,
  type SpaceId,
} from './shared';
import { PlanView } from './plan-view';

interface PlannerTabProps {
  space: SpaceId;
  profileForm: ProfileFormState;
  onProfileField: (field: keyof ProfileFormState, raw: string) => void;
  /** The combined household profile; used only in the us space. */
  householdProfile: UserProfile;
  prompt: string;
  onPromptChange: (value: string) => void;
  planning: boolean;
  planError: string | null;
  planResult: PlanResult | null;
  onPlan: () => void;
  onTrackGoal: () => void;
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
          <p className="muted source-note">
            An investment portfolio is credited toward the goal first and grows at its own rate;
            leave the fields empty to plan on cash alone.
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
        </>
      ) : null}
    </div>
  );
}
