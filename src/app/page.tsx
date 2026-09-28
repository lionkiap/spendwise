'use client';

/**
 * SpendWise client shell: two tabs over client-side state.
 *
 * Tab one (Goal Planner) posts the prompt and profile to /api/plan and renders
 * the returned PlanJSON. Tab two (Card Maximizer) runs the deterministic
 * routing engine entirely in the browser with zero model calls: routeExpense
 * ranks the wallet for the entered expense and walletAudit replays the logged
 * month to show what was left on the table.
 *
 * Client state persists in localStorage under sw_profile, sw_wallet and
 * sw_ledger. Storage reads happen inside effects so server prerender and
 * client hydration always agree.
 */
import { useEffect, useMemo, useState } from 'react';
import { routeExpense, walletAudit, type Recommendation } from '../lib/cards/engine';
import type { CardSpec, ExpenseCategory, LedgerEntry } from '../lib/cards/types';
import type { PlanJSON } from '../lib/planner/build';
import type { UserProfile } from '../lib/planner/goalspec';
import { CARDS } from '../lib/data/cards';

const PROFILE_KEY = 'sw_profile';
const WALLET_KEY = 'sw_wallet';
const LEDGER_KEY = 'sw_ledger';

type PlanParser = 'nemotron' | 'local-fallback';
type TabId = 'planner' | 'cards';

const DEFAULT_PROFILE: UserProfile = {
  age: 24,
  grossMonthlyIncome: 4800,
  monthlyExpenses: 2600,
  liquidSavings: 15000,
  cpfOaBalance: 12000,
  milesValuationCents: 1.8,
};

const DEFAULT_PROMPT = 'I want to buy a HDB worth about 600k by age 28';
const SAVINGS_EXAMPLE_PROMPT =
  'I wish to save up 1mil by 50 years old with my savings account at 1.8 percent pa';

const MILES_VALUATION_MIN = 1.4;
const MILES_VALUATION_MAX = 2.4;

const CATEGORIES: ReadonlyArray<{ value: ExpenseCategory; label: string }> = [
  { value: 'groceries', label: 'Groceries' },
  { value: 'dining', label: 'Dining' },
  { value: 'online_shopping', label: 'Online shopping' },
  { value: 'transport', label: 'Transport' },
  { value: 'petrol', label: 'Petrol' },
  { value: 'travel', label: 'Travel' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'entertainment', label: 'Entertainment' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'education', label: 'Education' },
  { value: 'medical', label: 'Medical' },
  { value: 'other', label: 'Other' },
];

const CATEGORY_VALUES: ReadonlyArray<string> = CATEGORIES.map((entry) => entry.value);

interface ProfileFormState {
  age: string;
  grossMonthlyIncome: string;
  monthlyExpenses: string;
  liquidSavings: string;
  cpfOaBalance: string;
}

interface ExpenseFormState {
  amount: string;
  category: ExpenseCategory;
  merchant: string;
}

interface PlanResult {
  plan: PlanJSON;
  parser: PlanParser;
}

/* ---------------------------------------------------------------------- */
/* Pure formatting helpers: deterministic, no locale or clock dependence.  */
/* ---------------------------------------------------------------------- */

function fmtMoney(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const negative = rounded < 0;
  const fixed = Math.abs(rounded).toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  let grouped = '';
  for (let index = 0; index < intPart.length; index += 1) {
    if (index > 0 && (intPart.length - index) % 3 === 0) {
      grouped += ',';
    }
    grouped += intPart[index];
  }
  const decimals = decPart === '00' ? '' : `.${decPart}`;
  return `${negative ? '-' : ''}S$${grouped}${decimals}`;
}

function fmtPct(ratio: number, digits = 2): string {
  const fixed = (ratio * 100).toFixed(digits);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return `${trimmed}%`;
}

function fmtAssumptionValue(field: string, value: number): string {
  if (field === 'deadlineAge') {
    return `age ${value}`;
  }
  if (field.endsWith('Pa')) {
    return `${fmtPct(value, 1)} a year`;
  }
  return fmtMoney(value);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function numberFrom(raw: string): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function profileFromForm(form: ProfileFormState, milesValuationCents: number): UserProfile {
  return {
    age: numberFrom(form.age),
    grossMonthlyIncome: numberFrom(form.grossMonthlyIncome),
    monthlyExpenses: numberFrom(form.monthlyExpenses),
    liquidSavings: numberFrom(form.liquidSavings),
    cpfOaBalance: numberFrom(form.cpfOaBalance),
    milesValuationCents,
  };
}

function currentMonthKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.cardId === 'string' &&
    typeof entry.amountSgd === 'number' &&
    Number.isFinite(entry.amountSgd) &&
    typeof entry.category === 'string' &&
    CATEGORY_VALUES.includes(entry.category) &&
    typeof entry.monthKey === 'string' &&
    /^\d{4}-\d{2}$/.test(entry.monthKey)
  );
}

function defaultProfileForm(): ProfileFormState {
  return {
    age: String(DEFAULT_PROFILE.age),
    grossMonthlyIncome: String(DEFAULT_PROFILE.grossMonthlyIncome),
    monthlyExpenses: String(DEFAULT_PROFILE.monthlyExpenses),
    liquidSavings: String(DEFAULT_PROFILE.liquidSavings),
    cpfOaBalance: String(DEFAULT_PROFILE.cpfOaBalance),
  };
}

/* ---------------------------------------------------------------------- */
/* Presentational components over the PlanJSON the API returns.            */
/* ---------------------------------------------------------------------- */

function VerdictHero({ plan }: { plan: PlanJSON }) {
  return (
    <section className={`verdict verdict-${plan.verdict.status}`}>
      <p className="verdict-kicker">{plan.verdict.status.replace('_', ' ')}</p>
      <h2 className="verdict-headline">{plan.verdict.headline}</h2>
      <p className="verdict-reasoning">{plan.verdict.reasoning}</p>
    </section>
  );
}

function StatRequired({ value }: { value: number }) {
  return (
    <div className="stat-row">
      <div className="stat">
        <span className="stat-label">Required monthly savings</span>
        <span className="stat-value">{fmtMoney(value)}</span>
      </div>
    </div>
  );
}

function CostStackTable({ plan }: { plan: PlanJSON }) {
  if (plan.costStack === undefined || plan.costStack.length === 0) {
    return null;
  }
  const total = plan.costStack.reduce((sum, row) => sum + row.amountSgd, 0);
  return (
    <section className="card">
      <h3 className="card-title">Cost stack</h3>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Amount</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {plan.costStack.map((row) => (
              <tr key={row.label}>
                <td className="strong">{row.label}</td>
                <td className="num">{fmtMoney(row.amountSgd)}</td>
                <td className="muted">{row.note}</td>
              </tr>
            ))}
            <tr>
              <td className="strong">Total upfront</td>
              <td className="num strong">{fmtMoney(total)}</td>
              <td className="muted" />
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ScheduleTable({ plan }: { plan: PlanJSON }) {
  return (
    <section className="card">
      <h3 className="card-title">Savings schedule</h3>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Year</th>
              <th className="num">Contributions</th>
              <th className="num">Interest</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {plan.savingsSchedule.map((row) => (
              <tr key={row.year}>
                <td>{row.year}</td>
                <td className="num">{fmtMoney(row.contributions)}</td>
                <td className="num">{fmtMoney(row.interest)}</td>
                <td className="num strong">{fmtMoney(row.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DebtPanel({ plan }: { plan: PlanJSON }) {
  const debt = plan.debt;
  if (debt === undefined) {
    return null;
  }
  return (
    <section className="card">
      <h3 className="card-title">Debt check</h3>
      <div className="debt-grid">
        <div className="debt-cell">
          <span className="muted">Loan principal</span>
          <span className="debt-figure">{fmtMoney(debt.loanPrincipalSgd)}</span>
        </div>
        <div className="debt-cell">
          <span className="muted">
            Installment at {fmtPct(debt.concessionary.ratePa, 1)} over {debt.concessionary.tenorYears} years
          </span>
          <span className="debt-figure">{fmtMoney(debt.concessionary.monthlyInstallment)}/mo</span>
        </div>
        <div className="debt-cell">
          <span className="muted">
            Stress tested at {fmtPct(debt.stress.ratePa, 1)} over {debt.stress.tenorYears} years
          </span>
          <span className="debt-figure">{fmtMoney(debt.stress.monthlyInstallment)}/mo</span>
        </div>
      </div>
      <div className="pill-row">
        <span className={`pill ${debt.msr.pass ? 'pill-pass' : 'pill-fail'}`}>
          MSR {debt.msr.pass ? 'pass' : 'fail'} at {fmtPct(debt.msr.ratio)} of income
        </span>
        <span className={`pill ${debt.tdsr.pass ? 'pill-pass' : 'pill-fail'}`}>
          TDSR {debt.tdsr.pass ? 'pass' : 'fail'} at {fmtPct(debt.tdsr.ratio)} of income
        </span>
      </div>
    </section>
  );
}

const SCENARIO_RATE_LABELS: ReadonlyArray<string> = ['Rate -1 pt', 'Stated rate', 'Rate +1 pt'];
const SCENARIO_CONTRIBUTION_LABELS: ReadonlyArray<string> = ['Save 20% less', 'As planned', 'Save 20% more'];

function ScenarioGrid({ plan }: { plan: PlanJSON }) {
  const cells = plan.scenarioGrid;
  if (cells.length !== 9) {
    return null;
  }
  return (
    <section className="card">
      <h3 className="card-title">Scenario grid</h3>
      <p className="muted scenario-caption">
        The monthly saving you make in each scenario and where you land at the deadline: red is
        short by that amount, green fits with the spare shown.
      </p>
      <div className="scenario-grid">
        <div className="scenario-head scenario-corner" aria-hidden="true">
          rate \ saving
        </div>
        {SCENARIO_CONTRIBUTION_LABELS.map((label) => (
          <div key={label} className="scenario-head">
            {label}
          </div>
        ))}
        {SCENARIO_RATE_LABELS.map((rateLabel, rateIndex) => (
          <ScenarioRow key={rateLabel} rateIndex={rateIndex} rateLabel={rateLabel} cells={cells} />
        ))}
      </div>
    </section>
  );
}

function ScenarioRow({
  rateIndex,
  rateLabel,
  cells,
}: {
  rateIndex: number;
  rateLabel: string;
  cells: PlanJSON['scenarioGrid'];
}) {
  return (
    <>
      <div className="scenario-head scenario-row-head">{rateLabel}</div>
      {SCENARIO_CONTRIBUTION_LABELS.map((_, contributionIndex) => {
        const cell = cells[rateIndex * 3 + contributionIndex];
        if (cell === undefined) {
          return <div key={contributionIndex} className="scenario-cell" />;
        }
        const gapAbs = Math.abs(cell.gapSgd);
        const landing =
          gapAbs < 1
            ? 'lands on target'
            : cell.achievable
              ? `${fmtMoney(gapAbs)} spare`
              : `${fmtMoney(gapAbs)} short`;
        return (
          <div
            key={contributionIndex}
            className={`scenario-cell ${cell.achievable ? 'scenario-yes' : 'scenario-no'}`}
          >
            <span className="scenario-flag">{cell.achievable ? 'fits' : 'short'}</span>
            <span className="scenario-money">{fmtMoney(cell.monthlySgd)}/mo</span>
            <span className="scenario-sub">{landing}</span>
          </div>
        );
      })}
    </>
  );
}

function MilestoneTimeline({ plan }: { plan: PlanJSON }) {
  return (
    <section className="card">
      <h3 className="card-title">Milestones</h3>
      <ol className="timeline">
        {plan.milestones.map((milestone) => (
          <li key={`${milestone.atAge}-${milestone.label}`} className="timeline-item">
            <span className="timeline-dot" aria-hidden="true" />
            <span className="timeline-label">{milestone.label}</span>
            <span className="pill pill-neutral">age {milestone.atAge}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TeachingAccordions({ plan }: { plan: PlanJSON }) {
  return (
    <section className="card">
      <h3 className="card-title">Teaching points</h3>
      {plan.teaching.map((point) => (
        <details key={point.title} className="accordion">
          <summary>{point.title}</summary>
          <p className="accordion-body">{point.body}</p>
        </details>
      ))}
    </section>
  );
}

function AssumptionChips({ plan }: { plan: PlanJSON }) {
  if (plan.assumptions.length === 0) {
    return null;
  }
  return (
    <section className="card">
      <h3 className="card-title">Assumptions applied</h3>
      <div className="chip-row">
        {plan.assumptions.map((assumption) => (
          <div
            key={`${assumption.field}-${assumption.value}`}
            className="assumption-chip"
            title={assumption.reason}
          >
            <span className="assumption-value">
              {assumption.field}: {fmtAssumptionValue(assumption.field, assumption.value)}
            </span>
            <span className="assumption-reason">{assumption.reason}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function PlanResultView({ result }: { result: PlanResult }) {
  const { plan } = result;
  return (
    <div className="stack">
      <p className="parser-line">
        <span className={`pill ${result.parser === 'nemotron' ? 'pill-info' : 'pill-neutral'}`}>
          {result.parser === 'nemotron'
            ? 'Parsed by Nemotron on Nebius'
            : 'Parsed by the local fallback parser'}
        </span>
      </p>
      <p className="goal-summary">{plan.goalSummary}</p>
      <VerdictHero plan={plan} />
      <section className="card">
        <h3 className="card-title">Three actions</h3>
        <ol className="action-list">
          {plan.actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ol>
      </section>
      <StatRequired value={plan.requiredMonthlySavings} />
      <CostStackTable plan={plan} />
      <ScheduleTable plan={plan} />
      <DebtPanel plan={plan} />
      <ScenarioGrid plan={plan} />
      <MilestoneTimeline plan={plan} />
      <TeachingAccordions plan={plan} />
      <AssumptionChips plan={plan} />
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Root component with the two tabs.                                       */
/* ---------------------------------------------------------------------- */

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>('planner');
  const [hydrated, setHydrated] = useState(false);
  const [monthKey, setMonthKey] = useState('');

  // Planner tab state.
  const [profileForm, setProfileForm] = useState<ProfileFormState>(defaultProfileForm);
  const [milesValuation, setMilesValuation] = useState(DEFAULT_PROFILE.milesValuationCents);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);

  // Cards tab state.
  const [wallet, setWallet] = useState<string[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [expense, setExpense] = useState<ExpenseFormState>({
    amount: '',
    category: 'dining',
    merchant: '',
  });
  const [lastSpend, setLastSpend] = useState<{
    amountSgd: number;
    category: ExpenseCategory;
    merchantText?: string;
  } | null>(null);

  // Hydrate from localStorage after mount so SSR and first render agree.
  useEffect(() => {
    try {
      const rawProfile = window.localStorage.getItem(PROFILE_KEY);
      if (rawProfile !== null) {
        const stored = JSON.parse(rawProfile) as Partial<UserProfile>;
        const base = defaultProfileForm();
        setProfileForm({
          age: String(stored.age ?? base.age),
          grossMonthlyIncome: String(stored.grossMonthlyIncome ?? base.grossMonthlyIncome),
          monthlyExpenses: String(stored.monthlyExpenses ?? base.monthlyExpenses),
          liquidSavings: String(stored.liquidSavings ?? base.liquidSavings),
          cpfOaBalance: String(stored.cpfOaBalance ?? base.cpfOaBalance),
        });
        if (typeof stored.milesValuationCents === 'number' && Number.isFinite(stored.milesValuationCents)) {
          setMilesValuation(clamp(stored.milesValuationCents, MILES_VALUATION_MIN, MILES_VALUATION_MAX));
        }
      }
      const rawWallet = window.localStorage.getItem(WALLET_KEY);
      if (rawWallet !== null) {
        const ids: unknown = JSON.parse(rawWallet);
        if (Array.isArray(ids)) {
          setWallet(ids.filter((id): id is string => typeof id === 'string' && CARDS.some((card) => card.id === id)));
        }
      }
      const rawLedger = window.localStorage.getItem(LEDGER_KEY);
      if (rawLedger !== null) {
        const entries: unknown = JSON.parse(rawLedger);
        if (Array.isArray(entries)) {
          setLedger(entries.filter(isLedgerEntry));
        }
      }
    } catch {
      // Corrupt storage falls back to defaults; nothing to recover here.
    }
    setMonthKey(currentMonthKey(new Date()));
    setHydrated(true);
  }, []);

  // Persist after hydration so the load effect never fights the save effects.
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profileFromForm(profileForm, milesValuation)));
  }, [hydrated, profileForm, milesValuation]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(WALLET_KEY, JSON.stringify(wallet));
  }, [hydrated, wallet]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  }, [hydrated, ledger]);

  const cardById = useMemo(() => new Map<string, CardSpec>(CARDS.map((card) => [card.id, card])), []);
  const walletCards = useMemo(() => CARDS.filter((card) => wallet.includes(card.id)), [wallet]);

  const monthEntries = useMemo(
    () => ledger.filter((entry) => entry.monthKey === monthKey),
    [ledger, monthKey]
  );

  const recommendations = useMemo(() => {
    if (lastSpend === null || walletCards.length === 0 || monthKey === '') {
      return null;
    }
    return routeExpense(walletCards, lastSpend, { monthKey, entries: ledger }, {
      milesValuationCents: milesValuation,
      monthKey,
    });
  }, [lastSpend, walletCards, ledger, monthKey, milesValuation]);

  const minSpendRows = useMemo(() => {
    return walletCards
      .filter((card) => card.minMonthlySpendSgd !== undefined)
      .map((card) => {
        const min = card.minMonthlySpendSgd as number;
        const spent = monthEntries
          .filter((entry) => entry.cardId === card.id)
          .reduce((sum, entry) => sum + entry.amountSgd, 0);
        return { card, min, spent, fraction: min > 0 ? spent / min : 1 };
      });
  }, [walletCards, monthEntries]);

  const capUsageRows = useMemo(() => {
    const rows: Array<{
      card: CardSpec;
      category: ExpenseCategory;
      spent: number;
      cap: number;
      fraction: number;
    }> = [];
    for (const card of walletCards) {
      for (const tier of card.earnStructure) {
        const cap = tier.capMonthlySgd;
        if (cap === undefined) {
          continue;
        }
        const spent = monthEntries
          .filter((entry) => entry.cardId === card.id && entry.category === tier.category)
          .reduce((sum, entry) => sum + entry.amountSgd, 0);
        rows.push({ card, category: tier.category, spent, cap, fraction: spent / cap });
      }
    }
    return rows.sort((a, b) => b.fraction - a.fraction).slice(0, 5);
  }, [walletCards, monthEntries]);

  const audit = useMemo(() => {
    if (walletCards.length === 0 || monthEntries.length === 0 || monthKey === '') {
      return null;
    }
    return walletAudit(walletCards, { monthKey, entries: monthEntries }, {
      milesValuationCents: milesValuation,
    });
  }, [walletCards, monthEntries, monthKey, milesValuation]);

  function toggleWallet(id: string): void {
    setWallet((previous) =>
      previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id]
    );
  }

  function updateProfileField(field: keyof ProfileFormState, raw: string): void {
    setProfileForm((previous) => ({ ...previous, [field]: raw }));
  }

  async function handlePlan(): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setPlanError('Write a goal first, for example "buy a HDB worth 600k by age 28".');
      setPlanResult(null);
      return;
    }
    setPlanning(true);
    setPlanError(null);
    try {
      const response = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed, profile: profileFromForm(profileForm, milesValuation) }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const message =
          data !== null && typeof data === 'object' && 'error' in data
            ? String((data as { error: unknown }).error)
            : `Plan request failed with status ${response.status}.`;
        setPlanError(message);
        setPlanResult(null);
      } else {
        const payload = data as { plan: PlanJSON; parser?: string };
        setPlanResult({
          plan: payload.plan,
          parser: payload.parser === 'nemotron' ? 'nemotron' : 'local-fallback',
        });
      }
    } catch {
      setPlanError('Could not reach the planner API. Check that the server is running.');
      setPlanResult(null);
    } finally {
      setPlanning(false);
    }
  }

  function handleRouteExpense(): void {
    const amount = Number(expense.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    const merchant = expense.merchant.trim();
    setLastSpend({
      amountSgd: amount,
      category: expense.category,
      merchantText: merchant ? merchant : undefined,
    });
  }

  function logRecommendation(recommendation: Recommendation): void {
    if (lastSpend === null || monthKey === '') {
      return;
    }
    const entry: LedgerEntry = {
      cardId: recommendation.cardId,
      amountSgd: lastSpend.amountSgd,
      category: lastSpend.category,
      monthKey,
    };
    setLedger((previous) => [...previous, entry]);
  }

  return (
    <main className="page">
      <header className="app-header">
        <h1 className="app-title">SpendWise</h1>
        <p className="tagline">
          Deterministic goal planning and credit card routing for Singapore. Illustrative numbers,
          real math.
        </p>
      </header>

      <nav className="tabs" role="tablist" aria-label="SpendWise tools">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'planner'}
          className={`tab ${activeTab === 'planner' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('planner')}
        >
          Goal Planner
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'cards'}
          className={`tab ${activeTab === 'cards' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('cards')}
        >
          Card Maximizer
        </button>
      </nav>

      {activeTab === 'planner' ? (
        <div role="tabpanel" className="stack">
          <section className="card">
            <h2 className="card-title">Your profile</h2>
            <div className="field-row">
              <label className="field">
                <span>Age</span>
                <input
                  type="number"
                  min={16}
                  max={80}
                  value={profileForm.age}
                  onChange={(event) => updateProfileField('age', event.target.value)}
                />
              </label>
              <label className="field">
                <span>Gross monthly income (S$)</span>
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={profileForm.grossMonthlyIncome}
                  onChange={(event) => updateProfileField('grossMonthlyIncome', event.target.value)}
                />
              </label>
              <label className="field">
                <span>Monthly expenses (S$)</span>
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={profileForm.monthlyExpenses}
                  onChange={(event) => updateProfileField('monthlyExpenses', event.target.value)}
                />
              </label>
              <label className="field">
                <span>Liquid savings (S$)</span>
                <input
                  type="number"
                  min={0}
                  step={500}
                  value={profileForm.liquidSavings}
                  onChange={(event) => updateProfileField('liquidSavings', event.target.value)}
                />
              </label>
              <label className="field">
                <span>CPF OA balance (S$)</span>
                <input
                  type="number"
                  min={0}
                  step={500}
                  value={profileForm.cpfOaBalance}
                  onChange={(event) => updateProfileField('cpfOaBalance', event.target.value)}
                />
              </label>
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">Your goal</h2>
            <label className="field">
              <span>Describe your goal in plain English</span>
              <textarea
                className="prompt-box"
                rows={3}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="I want to buy a HDB worth about 600k by age 28"
              />
            </label>
            <div className="chip-row">
              <button
                type="button"
                className="example-chip"
                onClick={() => setPrompt(SAVINGS_EXAMPLE_PROMPT)}
              >
                Example: save 1 million by 50 at 1.8 percent pa
              </button>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handlePlan}
                disabled={planning}
              >
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

          {planResult !== null ? <PlanResultView result={planResult} /> : null}
        </div>
      ) : (
        <div role="tabpanel" className="stack">
          <section className="card">
            <h2 className="card-title">Your wallet</h2>
            <div className="wallet-list">
              {CARDS.map((card) => {
                const checked = wallet.includes(card.id);
                return (
                  <label key={card.id} className={`wallet-item ${checked ? 'wallet-item-on' : ''}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggleWallet(card.id)} />
                    <span className="wallet-item-body">
                      <span className="wallet-item-name">{card.name}</span>
                      <span className="wallet-item-meta">
                        {card.issuer} ·{' '}
                        {card.rewardType === 'miles'
                          ? `${card.baseRate} mpd base`
                          : `${fmtPct(card.baseRate)} base`}
                        {card.minMonthlySpendSgd !== undefined
                          ? ` · min ${fmtMoney(card.minMonthlySpendSgd)}/mo`
                          : ''}{' '}
                        · fee {fmtMoney(card.annualFeeSgd)}/yr
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="muted source-note">
              Card terms are illustrative as of 2025 and every card carries a sourceNote. Verify
              with the issuer before relying on any of them.
            </p>
          </section>

          <section className="card">
            <h2 className="card-title">Miles valuation</h2>
            <div className="slider-row">
              <input
                type="range"
                min={MILES_VALUATION_MIN}
                max={MILES_VALUATION_MAX}
                step={0.05}
                value={milesValuation}
                aria-label="Miles valuation in SGD cents per mile"
                onChange={(event) => setMilesValuation(Number(event.target.value))}
              />
              <span className="slider-value">{milesValuation.toFixed(2)} cents per mile</span>
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">Route an expense</h2>
            <div className="field-row">
              <label className="field">
                <span>Amount (S$)</span>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={expense.amount}
                  onChange={(event) => setExpense((prev) => ({ ...prev, amount: event.target.value }))}
                  placeholder="120"
                />
              </label>
              <label className="field">
                <span>Category</span>
                <select
                  value={expense.category}
                  onChange={(event) =>
                    setExpense((prev) => ({ ...prev, category: event.target.value as ExpenseCategory }))
                  }
                >
                  {CATEGORIES.map((category) => (
                    <option key={category.value} value={category.value}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Merchant (optional)</span>
                <input
                  type="text"
                  value={expense.merchant}
                  onChange={(event) => setExpense((prev) => ({ ...prev, merchant: event.target.value }))}
                  placeholder="Cold Storage"
                />
              </label>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleRouteExpense}
                disabled={walletCards.length === 0 || !(Number(expense.amount) > 0)}
              >
                Find the best card
              </button>
              {walletCards.length === 0 ? (
                <span className="muted form-hint">Select at least one card above first.</span>
              ) : null}
            </div>
          </section>

          {recommendations !== null && lastSpend !== null ? (
            <section className="card">
              <h2 className="card-title">
                Ranked picks for {fmtMoney(lastSpend.amountSgd)} on {lastSpend.category.replace('_', ' ')}
              </h2>
              <ol className="rec-list">
                {recommendations.map((recommendation, index) => {
                  const card = cardById.get(recommendation.cardId);
                  return (
                    <li
                      key={recommendation.cardId}
                      className={`rec ${index === 0 ? 'rec-best' : ''}`}
                    >
                      <div className="rec-head">
                        <span className="rec-rank">#{index + 1}</span>
                        <span className="rec-name">{card?.name ?? recommendation.cardId}</span>
                        <span className="rec-reward">
                          {fmtMoney(recommendation.rewardValueSgd)}
                          <span className="rec-rate">
                            {' '}
                            ({recommendation.effectiveRatePct.toFixed(2)}% effective)
                          </span>
                        </span>
                      </div>
                      {recommendation.conditional ? (
                        <p className="pill pill-warn">
                          Minimum monthly spend not met: base rate only on this purchase
                        </p>
                      ) : null}
                      <pre className="math-trace">{recommendation.mathTrace.join('\n')}</pre>
                      <div className="rec-foot">
                        <small className="muted source-note">{card?.sourceNote}</small>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => logRecommendation(recommendation)}
                        >
                          Log it
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <p className="muted source-note">
                Logging appends the purchase to the ledger, which updates caps, minimum spends and
                the audit below.
              </p>
            </section>
          ) : null}

          <section className="card">
            <div className="card-title-row">
              <h2 className="card-title">This month{monthKey ? ` (${monthKey})` : ''}</h2>
              <button type="button" className="btn btn-ghost" onClick={() => setLedger([])}>
                Clear log
              </button>
            </div>
            <p className="muted">
              {monthEntries.length} purchase{monthEntries.length === 1 ? '' : 's'} logged this month.
            </p>

            <h3 className="section-subtitle">Minimum spend progress</h3>
            {minSpendRows.length === 0 ? (
              <p className="muted">
                No wallet card carries a monthly minimum spend, or the wallet is empty.
              </p>
            ) : (
              <div className="progress-stack">
                {minSpendRows.map((row) => (
                  <div key={row.card.id} className="progress-row">
                    <span className="progress-label">{row.card.name}</span>
                    <div className="progress">
                      <div
                        className={`progress-fill ${row.spent >= row.min ? 'progress-done' : ''}`}
                        style={{ width: `${Math.min(100, row.fraction * 100)}%` }}
                      />
                    </div>
                    <span className="progress-value">
                      {fmtMoney(row.spent)} of {fmtMoney(row.min)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <h3 className="section-subtitle">Top category cap usage</h3>
            {capUsageRows.length === 0 ? (
              <p className="muted">No capped bonus tiers in the wallet, or the wallet is empty.</p>
            ) : (
              <div className="progress-stack">
                {capUsageRows.map((row) => (
                  <div
                    key={`${row.card.id}-${row.category}`}
                    className="progress-row"
                  >
                    <span className="progress-label">
                      {row.card.name} · {row.category.replace('_', ' ')}
                    </span>
                    <div className="progress">
                      <div
                        className={`progress-fill ${row.spent >= row.cap ? 'progress-done' : ''}`}
                        style={{ width: `${Math.min(100, row.fraction * 100)}%` }}
                      />
                    </div>
                    <span className="progress-value">
                      {fmtMoney(row.spent)} of {fmtMoney(row.cap)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <h3 className="section-subtitle">Left on the table</h3>
            {audit === null ? (
              <p className="muted">Log at least one purchase this month to run the audit.</p>
            ) : (
              <div className="audit">
                <p>
                  Logged cards earned <strong>{fmtMoney(audit.actualValueSgd)}</strong> while the
                  always-optimal chooser would have earned{' '}
                  <strong>{fmtMoney(audit.optimalValueSgd)}</strong>:{' '}
                  <strong className={audit.leftOnTableSgd > 0 ? 'audit-gap' : 'audit-clean'}>
                    {fmtMoney(audit.leftOnTableSgd)} left on the table
                  </strong>
                  .
                </p>
                {audit.misses.length === 0 ? (
                  <p className="muted">No misses: every purchase went on the best available card.</p>
                ) : (
                  <ul className="audit-misses">
                    {audit.misses.map((miss) => (
                      <li key={miss.index}>
                        <span className="pill pill-fail">{fmtMoney(miss.lostSgd)} lost</span>{' '}
                        {miss.why}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      <footer className="app-footer">
        <p>
          Educational hackathon demo, not financial advice. Duty tables, loan caps and card terms
          are illustrative snapshots that must be verified against IRAS, MAS, CPF and the issuers.
        </p>
      </footer>
    </main>
  );
}
