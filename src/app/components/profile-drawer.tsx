'use client';

/**
 * Profile drawer: the per-space profile form (You and Partner) and the
 * read-only household card (Us), extracted from the planner tab so the
 * planner keeps only the prompt, plan and what-if advisor. An accessible
 * dialog via the shared Drawer primitive; edits apply live through the same
 * onProfileField setter the planner form always used, so nothing about the
 * profile pipeline changes.
 */
import { employeeCpfContribution } from '../../lib/kernels';
import { PLANNER_DEFAULTS, type UserProfile } from '../../lib/planner/goalspec';

import { fmtMoney, type ProfileFormState, type SpaceId } from './shared';
import { Drawer } from './drawer';

interface ProfileDrawerProps {
  open: boolean;
  onClose: () => void;
  space: SpaceId;
  profileForm: ProfileFormState;
  onProfileField: (field: keyof ProfileFormState, raw: string) => void;
  /** The planning profile of the space: personal in You and Partner, combined in Us. */
  householdProfile: UserProfile;
}

/** The read-only household card, shown in the Us space. */
function HouseholdCard({ householdProfile }: { householdProfile: UserProfile }) {
  return (
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
  );
}

/** The editable personal profile form, shown in the You and Partner spaces. */
function ProfileForm({
  space,
  profileForm,
  onProfileField,
}: {
  space: SpaceId;
  profileForm: ProfileFormState;
  onProfileField: (field: keyof ProfileFormState, raw: string) => void;
}) {
  return (
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
  );
}

export function ProfileDrawer({
  open,
  onClose,
  space,
  profileForm,
  onProfileField,
  householdProfile,
}: ProfileDrawerProps) {
  return (
    <Drawer open={open} onClose={onClose} label="Edit profile" variant="side">
      <div className="drawer-head">
        <h2 className="drawer-title">Edit profile</h2>
        <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="drawer-body">
        {space === 'us' ? (
          <HouseholdCard householdProfile={householdProfile} />
        ) : (
          <ProfileForm space={space} profileForm={profileForm} onProfileField={onProfileField} />
        )}
        <div className="drawer-foot">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Drawer>
  );
}
