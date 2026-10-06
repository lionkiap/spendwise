/**
 * Presentational rendering of the PlanJSON the API returns.
 *
 * Every figure below comes from the deterministic kernels; this file only
 * formats and lays out. The verdict hero is the dark gradient panel carrying
 * the status chip, headline and the required-monthly stat, and the teaching
 * section carries an engine badge saying who wrote the words.
 */
import type { PlanJSON } from '../../lib/planner/build';
import { assumptionLabel, fmtAssumptionValue, fmtMoney, fmtPct, type PlanResult } from './shared';

function verdictLabel(status: PlanJSON['verdict']['status']): string {
  return status.replace('_', ' ');
}

function VerdictHero({ plan }: { plan: PlanJSON }) {
  return (
    <section
      className={`verdict-hero verdict-hero-${plan.verdict.status}`}
      aria-label="Verdict"
    >
      <div className="verdict-hero-main">
        <span className={`verdict-chip verdict-chip-${plan.verdict.status}`}>
          {verdictLabel(plan.verdict.status)}
        </span>
        <h2 className="verdict-headline">{plan.verdict.headline}</h2>
        <p className="verdict-reasoning">{plan.verdict.reasoning}</p>
      </div>
      <div className="verdict-hero-stat">
        <span className="verdict-stat-label">Required monthly savings</span>
        <span className="verdict-stat-value">{fmtMoney(plan.requiredMonthlySavings)}</span>
      </div>
    </section>
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

/** Per-year TCO components in display order, matching TcoYearly keys. */
const TCO_ROWS: ReadonlyArray<{
  key: 'loan' | 'insurance' | 'roadTax' | 'energy' | 'maintenance';
  label: string;
}> = [
  { key: 'loan', label: 'Financing (loan interest)' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'roadTax', label: 'Road tax' },
  { key: 'energy', label: 'Energy' },
  { key: 'maintenance', label: 'Maintenance' },
];

/** Total cost of ownership card, rendered for car goals only. */
function TcoCard({ plan }: { plan: PlanJSON }) {
  const tco = plan.tco;
  if (tco === undefined) {
    return null;
  }
  return (
    <section className="card">
      <h3 className="card-title">Total cost of ownership</h3>
      <p className="muted scenario-caption">
        Average cost per ownership year, by component, from the TCO kernel.
      </p>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Component</th>
              <th className="num">Per year</th>
            </tr>
          </thead>
          <tbody>
            {TCO_ROWS.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td className="num">{fmtMoney(tco.yearly[row.key])}</td>
              </tr>
            ))}
            <tr>
              <td className="strong">All-in per year</td>
              <td className="num strong">{fmtMoney(tco.yearly.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="tco-total">
        <span className="muted">Total over the ownership horizon</span>{' '}
        <strong className="tco-total-value">{fmtMoney(tco.total)}</strong>
      </p>
      <ul className="tco-assumptions">
        {tco.assumptions.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
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
  const ultra = plan.narrativeEngine === 'ultra';
  return (
    <section className="card">
      <div className="teaching-head">
        <h3 className="card-title">Teaching points</h3>
        <span className={`engine-badge ${ultra ? 'engine-badge-ultra' : 'engine-badge-neutral'}`}>
          {ultra ? 'Explanations by Nemotron Ultra' : 'Deterministic explanations'}
        </span>
      </div>
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
            title={assumption.field}
          >
            <span className="assumption-value">
              {assumptionLabel(assumption.field)}: {fmtAssumptionValue(assumption.field, assumption.value)}
            </span>
            <span className="assumption-reason">{assumption.reason}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function PlanView({ result }: { result: PlanResult }) {
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
      <CostStackTable plan={plan} />
      <TcoCard plan={plan} />
      <ScheduleTable plan={plan} />
      <DebtPanel plan={plan} />
      <ScenarioGrid plan={plan} />
      <MilestoneTimeline plan={plan} />
      <TeachingAccordions plan={plan} />
      <AssumptionChips plan={plan} />
    </div>
  );
}
