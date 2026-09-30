'use client';

/**
 * Progress tab: the tracked-goal dashboard.
 *
 * The planner compiles a goal; this tab holds it accountable. Each tracked
 * goal gets a sheet with a progress ring, pace verdict, projected landing and
 * a hand-rolled SVG trajectory chart (planned curve versus actual points, no
 * chart library). Every number comes from the pure functions in
 * src/lib/planner/progress.ts, which lean on the kernels; this file only
 * draws what they compute.
 */
import { useEffect, useState } from 'react';

import {
  actualPace,
  chartSeries,
  monthKeyDiff,
  monthsToTarget,
  paceStatus,
  plannedBalance,
  progressRatio,
  projectedBalanceAtDeadline,
  type TrackedGoal,
} from '../../lib/planner/progress';
import type { UserProfile } from '../../lib/planner/goalspec';

import { fmtMoney, type TabId } from './shared';

interface DashboardTabProps {
  goals: TrackedGoal[];
  profile: UserProfile;
  monthKey: string;
  onDeleteGoal: (goalId: string) => void;
  onLogSavings: (goalId: string, monthKey: string, contributedSgd: number, note: string) => void;
  onDeleteLog: (goalId: string, logMonthKey: string) => void;
  onGoToPlanner: (tab: TabId) => void;
}

export function DashboardTab({
  goals,
  profile,
  monthKey,
  onDeleteGoal,
  onLogSavings,
  onDeleteLog,
  onGoToPlanner,
}: DashboardTabProps) {
  return (
    <div className="stack">
      <PositionStrip profile={profile} />
      {goals.length === 0 ? (
        <section className="card dash-empty">
          <h2 className="card-title">No tracked goals yet</h2>
          <p className="muted">
            Build a plan in the Goal Planner, then press Track this goal. The dashboard takes it
            from there: log what you save each month and watch the trajectory against the plan.
          </p>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={() => onGoToPlanner('planner')}>
              Go to the Goal Planner
            </button>
          </div>
        </section>
      ) : (
        goals.map((goal) => (
          <GoalSheet
            key={goal.id}
            goal={goal}
            monthKey={monthKey}
            onDeleteGoal={onDeleteGoal}
            onLogSavings={onLogSavings}
            onDeleteLog={onDeleteLog}
          />
        ))
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Net position strip                                                  */
/* ------------------------------------------------------------------ */

function PositionStrip({ profile }: { profile: UserProfile }) {
  const cash = Math.max(0, profile.liquidSavings);
  const cpf = Math.max(0, profile.cpfOaBalance);
  const investments = Math.max(0, profile.investmentsSgd ?? 0);
  const total = cash + cpf + investments;
  if (total <= 0) {
    return null;
  }
  const parts = [
    { label: 'Cash', value: cash, className: 'pos-fill-cash' },
    { label: 'CPF OA', value: cpf, className: 'pos-fill-cpf' },
    { label: 'Investments', value: investments, className: 'pos-fill-inv' },
  ].filter((part) => part.value > 0);

  return (
    <section className="card">
      <div className="card-title-row">
        <h2 className="card-title">Your position today</h2>
        <span className="pos-total">{fmtMoney(total)}</span>
      </div>
      <div className="pos-bar" role="img" aria-label={`Position split: ${parts.map((p) => `${p.label} ${fmtMoney(p.value)}`).join(', ')}`}>
        {parts.map((part) => (
          <div
            key={part.label}
            className={`pos-fill ${part.className}`}
            style={{ width: `${(part.value / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="pill-row pos-legend">
        {parts.map((part) => (
          <span key={part.label} className="pill pill-neutral">
            {part.label} {fmtMoney(part.value)}
          </span>
        ))}
      </div>
      <p className="muted form-hint">
        From your profile. CPF OA grows with salary contributions and can fund part of a property
        down payment; the planner tracks the cash leg here.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* One tracked goal                                                    */
/* ------------------------------------------------------------------ */

function GoalSheet({
  goal,
  monthKey,
  onDeleteGoal,
  onLogSavings,
  onDeleteLog,
}: {
  goal: TrackedGoal;
  monthKey: string;
  onDeleteGoal: (goalId: string) => void;
  onLogSavings: (goalId: string, monthKey: string, contributedSgd: number, note: string) => void;
  onDeleteLog: (goalId: string, logMonthKey: string) => void;
}) {
  const [logMonth, setLogMonth] = useState(monthKey);
  const [logAmount, setLogAmount] = useState('');
  const [logNote, setLogNote] = useState('');

  const elapsed = Math.max(0, monthKeyDiff(goal.startMonthKey, monthKey));
  const totalMonths = Math.max(1, (goal.deadlineAge - goal.startAge) * 12);
  const monthsLeft = Math.max(0, totalMonths - elapsed);
  const ratio = progressRatio(goal, elapsed);
  const status = paceStatus(goal, elapsed);
  const pace = actualPace(goal, elapsed);
  const projected = projectedBalanceAtDeadline(goal, elapsed);
  const plannedNow = plannedBalance(goal, elapsed);
  const finishMonths = monthsToTarget(goal.startSavingsSgd, goal.ratePa, pace, goal.targetSgd);
  const finishAge =
    finishMonths === null
      ? null
      : goal.startAge + Math.ceil(finishMonths / 12);
  const actualTotal = goal.logs.reduce((sum, log) => sum + log.contributedSgd, 0);

  function submitLog(): void {
    const parsed = Number(logAmount);
    if (!Number.isFinite(parsed) || parsed <= 0 || !/^\d{4}-\d{2}$/.test(logMonth)) {
      return;
    }
    onLogSavings(goal.id, logMonth, Math.round(parsed * 100) / 100, logNote.trim());
    setLogAmount('');
    setLogNote('');
  }

  return (
    <section className="card sheet">
      <div className="card-title-row">
        <h2 className="card-title">{goal.name}</h2>
        <div className="pill-row">
          <span className="pill pill-neutral">by age {goal.deadlineAge}</span>
          <span
            className={`pill ${status === 'behind' ? 'pill-fail' : status === 'ahead' ? 'pill-pass' : 'pill-warn'}`}
          >
            {status === 'behind' ? 'Behind plan' : status === 'ahead' ? 'Ahead of plan' : 'On plan'}
          </span>
          <button type="button" className="btn btn-danger btn-small" onClick={() => onDeleteGoal(goal.id)}>
            Stop tracking
          </button>
        </div>
      </div>

      <div className="sheet-stats">
        <ProgressRing ratio={ratio} />
        <div className="stat-grid">
          <Stat label="Saved so far" value={fmtMoney(actualTotal)} sub={`plan: ${fmtMoney(plannedNow)}`} />
          <Stat
            label="Required / month"
            value={fmtMoney(goal.requiredMonthlySgd)}
            sub={`actual pace: ${fmtMoney(pace)}`}
          />
          <Stat
            label="Months left"
            value={String(monthsLeft)}
            sub={elapsed === 0 ? 'tracking starts this month' : `${elapsed} elapsed`}
          />
          <Stat
            label={`At age ${goal.deadlineAge}`}
            value={fmtMoney(projected)}
            sub={
              finishAge === null
                ? 'never at this pace'
                : finishAge <= goal.deadlineAge
                  ? `lands at age ${finishAge}`
                  : `at this pace age ${finishAge}`
            }
            warn={projected < goal.targetSgd}
          />
        </div>
      </div>

      <TrajectoryChart goal={goal} elapsed={elapsed} />

      <div className="sheet-log">
        <h3 className="section-subtitle">Log this month's saving</h3>
        <div className="field-row log-form">
          <label className="field">
            <span>Month</span>
            <input
              type="month"
              value={logMonth}
              min={goal.startMonthKey}
              onChange={(event) => setLogMonth(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Amount saved (S$)</span>
            <input
              type="number"
              min={0}
              step={50}
              value={logAmount}
              placeholder={String(Math.round(goal.requiredMonthlySgd))}
              onChange={(event) => setLogAmount(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Note (optional)</span>
            <input
              type="text"
              value={logNote}
              placeholder="bonus, side income..."
              onChange={(event) => setLogNote(event.target.value)}
            />
          </label>
          <div className="field log-submit">
            <span aria-hidden="true">&nbsp;</span>
            <button type="button" className="btn btn-primary" onClick={submitLog}>
              Log
            </button>
          </div>
        </div>

        {goal.logs.length > 0 ? (
          <div className="table-scroll">
            <table className="table ledger-table log-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Saved</th>
                  <th>Note</th>
                  <th aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {[...goal.logs]
                  .sort((a, b) => (a.monthKey < b.monthKey ? 1 : -1))
                  .map((log) => (
                    <tr key={log.monthKey}>
                      <td>{log.monthKey}</td>
                      <td className="money">{fmtMoney(log.contributedSgd)}</td>
                      <td className="muted">{log.note ?? ''}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-small"
                          onClick={() => onDeleteLog(goal.id, log.monthKey)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">
            No savings logged yet. Each log feeds the actual line on the chart above.
          </p>
        )}
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  warn = false,
}: {
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${warn ? 'stat-warn' : ''}`}>{value}</span>
      {sub !== undefined ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SVG pieces: ring and trajectory chart                               */
/* ------------------------------------------------------------------ */

function ProgressRing({ ratio }: { ratio: number }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const [grown, setGrown] = useState(false);
  // Grow the arc from zero whenever the ratio settles or changes; the CSS
  // transition on .ring-fill does the drawing.
  useEffect(() => {
    setGrown(false);
    const timer = window.setTimeout(() => setGrown(true), 50);
    return () => window.clearTimeout(timer);
  }, [clamped]);

  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const dash = grown ? circumference * clamped : 0;
  const overTarget = ratio >= 1;
  return (
    <div className="ring">
      <svg viewBox="0 0 120 120" className="ring-svg" role="img" aria-label={`Progress ${Math.round(clamped * 100)} percent of the target`}>
        <circle cx="60" cy="60" r={radius} className="ring-track" />
        <circle
          cx="60"
          cy="60"
          r={radius}
          className={overTarget ? 'ring-fill ring-fill-done' : 'ring-fill'}
          strokeDasharray={`${dash} ${circumference - dash}`}
        />
      </svg>
      <div className="ring-center">
        <span className="ring-pct">{overTarget ? '100%' : `${Math.round(clamped * 100)}%`}</span>
        <span className="ring-label">of target</span>
      </div>
    </div>
  );
}

function TrajectoryChart({ goal, elapsed }: { goal: TrackedGoal; elapsed: number }) {
  const series = chartSeries(goal, elapsed);
  const width = 640;
  const height = 220;
  const padLeft = 56;
  const padRight = 16;
  const padTop = 18;
  const padBottom = 30;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const maxValue = Math.max(goal.targetSgd, ...series.planned.map((point) => point.balance), 1);
  const x = (month: number): number => padLeft + (month / series.totalMonths) * plotWidth;
  const y = (balance: number): number => padTop + plotHeight - (balance / maxValue) * plotHeight;

  const plannedPath = series.planned
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.month).toFixed(1)},${y(point.balance).toFixed(1)}`)
    .join(' ');
  const plannedArea = `${plannedPath} L${x(series.totalMonths).toFixed(1)},${(padTop + plotHeight).toFixed(1)} L${padLeft},${(padTop + plotHeight).toFixed(1)} Z`;
  const actualPath = series.actual
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.month).toFixed(1)},${y(point.balance).toFixed(1)}`)
    .join(' ');

  const ticks = [0, 0.5, 1].map((fraction) => Math.round((maxValue * fraction) / 100) * 100);
  const ageAt = (month: number): number => goal.startAge + month / 12;

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label="Planned savings curve versus actual saved">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={padLeft} x2={width - padRight} y1={y(tick)} y2={y(tick)} className="chart-grid" />
            <text x={padLeft - 8} y={y(tick) + 4} className="chart-axis" textAnchor="end">
              {shortMoney(tick)}
            </text>
          </g>
        ))}

        <path d={plannedArea} className="chart-area" />
        <path d={plannedPath} className="chart-planned" />
        <line
          x1={padLeft}
          x2={width - padRight}
          y1={y(goal.targetSgd)}
          y2={y(goal.targetSgd)}
          className="chart-target"
        />
        <text x={width - padRight} y={y(goal.targetSgd) - 5} className="chart-axis chart-target-label" textAnchor="end">
          target {shortMoney(goal.targetSgd)}
        </text>

        {elapsed > 0 ? (
          <line x1={x(elapsed)} x2={x(elapsed)} y1={padTop} y2={padTop + plotHeight} className="chart-now" />
        ) : null}

        {series.actual.length > 1 ? <path d={actualPath} className="chart-actual" /> : null}
        {series.actual.map((point) => (
          <circle key={point.month} cx={x(point.month)} cy={y(point.balance)} r={3.2} className="chart-dot" />
        ))}

        {[0, Math.round(series.totalMonths / 2), series.totalMonths].map((month, index) => (
          <text
            key={month}
            x={x(month)}
            y={height - 8}
            className="chart-axis"
            textAnchor={index === 0 ? 'start' : index === 2 ? 'end' : 'middle'}
          >
            age {Math.round(ageAt(month))}
          </text>
        ))}
      </svg>
      <figcaption className="chart-legend pill-row">
        <span className="chart-key chart-key-planned">planned</span>
        <span className="chart-key chart-key-actual">actual</span>
        {elapsed > 0 ? <span className="muted chart-now-label">today: month {elapsed}</span> : null}
      </figcaption>
    </figure>
  );
}

/** Compact money for chart axes: S$182,139 becomes S$182k. */
function shortMoney(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `S$${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}m`;
  }
  if (Math.abs(value) >= 1_000) {
    return `S$${Math.round(value / 1_000)}k`;
  }
  return `S$${Math.round(value)}`;
}
