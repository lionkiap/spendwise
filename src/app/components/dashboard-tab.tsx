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
 *
 * The tab is built to feel alive: sections reveal as they scroll into view,
 * the chart draws itself, stat tiles count up and expand their explanations
 * on tap, chart dots are tappable for a month readout, the ring replays on
 * tap, and a freshly logged month pulses in the table. Everything defers to
 * prefers-reduced-motion.
 */
import { useEffect, useRef, useState } from 'react';

import {
  actualBalance,
  actualPace,
  chartSeries,
  chartSeriesByContributor,
  contributorTotals,
  monthKeyDiff,
  monthsToTarget,
  paceStatus,
  plannedBalance,
  progressRatio,
  projectedBalanceAtDeadline,
  type TrackedGoal,
} from '../../lib/planner/progress';
import type { UserProfile } from '../../lib/planner/goalspec';

import { fmtMoney, type SpaceId, type TabId } from './shared';

/* ------------------------------------------------------------------ */
/* Motion helpers                                                      */
/* ------------------------------------------------------------------ */

type RevealState = 'pending' | 'armed' | 'revealed';

/**
 * Scroll-reveal: arms after mount (so server-rendered content is never lost),
 * then flips to revealed when the element scrolls into view.
 */
function useReveal<T extends HTMLElement>(threshold = 0.15): [React.RefObject<T>, RevealState] {
  const ref = useRef<T>(null);
  const [state, setState] = useState<RevealState>('pending');

  useEffect(() => {
    const node = ref.current;
    if (node === null) {
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setState('revealed');
      return;
    }
    setState('armed');
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setState('revealed');
            observer.disconnect();
          }
        }
      },
      { threshold }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);

  return [ref, state];
}

function revealClass(state: RevealState): string {
  if (state === 'pending') {
    return '';
  }
  return state === 'revealed' ? 'reveal-init revealed' : 'reveal-init';
}

/** Eased count-up toward the target number, skipped under reduced motion. */
function useCountUp(target: number, durationMs = 700): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);

  useEffect(() => {
    if (fromRef.current === target) {
      return;
    }
    if (typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    const from = fromRef.current;
    fromRef.current = target;
    const start = window.performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (target - from) * eased);
      if (progress < 1) {
        frame = window.requestAnimationFrame(tick);
      }
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return display;
}

/* ------------------------------------------------------------------ */
/* Dashboard shell                                                     */
/* ------------------------------------------------------------------ */

interface DashboardTabProps {
  space: SpaceId;
  goals: TrackedGoal[];
  profile: UserProfile;
  monthKey: string;
  onDeleteGoal: (goalId: string) => void;
  onLogSavings: (
    goalId: string,
    monthKey: string,
    contributedSgd: number,
    note: string,
    contributor: 'you' | 'partner'
  ) => void;
  onDeleteLog: (goalId: string, logMonthKey: string) => void;
  onGoToPlanner: (tab: TabId) => void;
}

export function DashboardTab({
  space,
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
      <PositionStrip profile={profile} space={space} />
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
            space={space}
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

function PositionStrip({ profile, space }: { profile: UserProfile; space: SpaceId }) {
  const [ref, reveal] = useReveal<HTMLElement>();
  const cash = Math.max(0, profile.liquidSavings);
  const cpf = Math.max(0, profile.cpfOaBalance);
  const investments = Math.max(0, profile.investmentsSgd ?? 0);
  const total = cash + cpf + investments;
  if (total <= 0) {
    return null;
  }
  const shown = reveal === 'revealed';
  const parts = [
    { label: 'Cash', value: cash, className: 'pos-fill-cash' },
    { label: 'CPF OA', value: cpf, className: 'pos-fill-cpf' },
    { label: 'Investments', value: investments, className: 'pos-fill-inv' },
  ].filter((part) => part.value > 0);

  return (
    <section className={`card ${revealClass(reveal)}`} ref={ref}>
      <div className="card-title-row">
        <h2 className="card-title">{space === 'us' ? 'Household position today' : 'Your position today'}</h2>
        <span className="pos-total">{fmtMoney(total)}</span>
      </div>
      <div className="pos-bar" role="img" aria-label={`Position split: ${parts.map((p) => `${p.label} ${fmtMoney(p.value)}`).join(', ')}`}>
        {parts.map((part, index) => (
          <div
            key={part.label}
            className={`pos-fill ${part.className}`}
            style={{ width: shown ? `${(part.value / total) * 100}%` : '0%', transitionDelay: `${index * 110}ms` }}
          />
        ))}
      </div>
      <div className="pill-row pos-legend">
        {parts.map((part, index) => (
          <span
            key={part.label}
            className="pill pill-neutral pos-pill"
            style={{ transitionDelay: `${180 + index * 90}ms` }}
          >
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
  space,
  goal,
  monthKey,
  onDeleteGoal,
  onLogSavings,
  onDeleteLog,
}: {
  space: SpaceId;
  goal: TrackedGoal;
  monthKey: string;
  onDeleteGoal: (goalId: string) => void;
  onLogSavings: (
    goalId: string,
    monthKey: string,
    contributedSgd: number,
    note: string,
    contributor: 'you' | 'partner'
  ) => void;
  onDeleteLog: (goalId: string, logMonthKey: string) => void;
}) {
  const [logMonth, setLogMonth] = useState(monthKey);
  const [logAmount, setLogAmount] = useState('');
  const [logNote, setLogNote] = useState('');
  const [logContributor, setLogContributor] = useState<'you' | 'partner'>('you');
  const [lastLogged, setLastLogged] = useState<string | null>(null);

  const [statsRef, statsReveal] = useReveal<HTMLDivElement>();
  const [chartRef, chartReveal] = useReveal<HTMLElement>();
  const [logRef, logReveal] = useReveal<HTMLDivElement>();

  const isUsGoal = space === 'us' && (goal.space ?? 'you') === 'us';
  const elapsed = Math.max(0, monthKeyDiff(goal.startMonthKey, monthKey));
  const totalMonths = Math.max(1, (goal.deadlineAge - goal.startAge) * 12);
  const monthsLeft = Math.max(0, totalMonths - elapsed);
  const ratio = progressRatio(goal, elapsed);
  const status = paceStatus(goal, elapsed);
  const pace = actualPace(goal, elapsed);
  const projected = projectedBalanceAtDeadline(goal, elapsed);
  const plannedNow = plannedBalance(goal, elapsed);
  const finishMonths = monthsToTarget(goal.startSavingsSgd, goal.ratePa, pace, goal.targetSgd);
  const finishAge = finishMonths === null ? null : goal.startAge + Math.ceil(finishMonths / 12);
  const actualTotal = goal.logs.reduce((sum, log) => sum + log.contributedSgd, 0);
  const totals = contributorTotals(goal, elapsed);

  function submitLog(): void {
    const parsed = Number(logAmount);
    if (!Number.isFinite(parsed) || parsed <= 0 || !/^\d{4}-\d{2}$/.test(logMonth)) {
      return;
    }
    onLogSavings(goal.id, logMonth, Math.round(parsed * 100) / 100, logNote.trim(), logContributor);
    setLastLogged(logMonth);
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

      <div className={`sheet-stats ${revealClass(statsReveal)}`} ref={statsRef}>
        <ProgressRing ratio={ratio} />
        <div className="stat-grid">
          <Stat
            label="Saved so far"
            value={actualTotal}
            format={fmtMoney}
            sub={
              isUsGoal
                ? `you ${fmtMoney(totals.you)} · partner ${fmtMoney(totals.partner)}`
                : `plan: ${fmtMoney(plannedNow)}`
            }
            detail="The total of your logged savings for this goal. The plan figure beside it is where the original plan's curve said you would be by now, starting pot and growth included. Tap any tile to collapse this note."
          />
          <Stat
            label="Required / month"
            value={goal.requiredMonthlySgd}
            format={fmtMoney}
            sub={`actual pace: ${fmtMoney(pace)}`}
            detail="The plan's solved figure: the monthly amount that, growing at the goal's rate, reaches the target by the deadline. Your actual pace is the average of what you have logged each elapsed month."
          />
          <Stat
            label="Months left"
            value={monthsLeft}
            format={(n) => String(Math.round(n))}
            sub={elapsed === 0 ? 'tracking starts this month' : `${elapsed} elapsed`}
            detail="Calendar months between now and the deadline age recorded when the goal was tracked. Re-track the goal to re-baseline the clock."
          />
          <Stat
            label={`At age ${goal.deadlineAge}`}
            value={projected}
            format={fmtMoney}
            sub={
              finishAge === null
                ? 'never at this pace'
                : finishAge <= goal.deadlineAge
                  ? `lands at age ${finishAge}`
                  : `at this pace age ${finishAge}`
            }
            warn={projected < goal.targetSgd}
            detail={`Where your observed pace lands by the deadline if it continues, grown at ${Math.round(goal.ratePa * 10000) / 100} percent a year. Below the target of ${fmtMoney(goal.targetSgd)} the tile turns red.`}
          />
        </div>
      </div>

      <figure className={`chart ${revealClass(chartReveal)}`} ref={chartRef}>
        <TrajectoryChart goal={goal} elapsed={elapsed} revealed={chartReveal === 'revealed'} />
      </figure>

      <div className={`sheet-log ${revealClass(logReveal)}`} ref={logRef}>
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
          {isUsGoal ? (
            <div className="field log-contributor" role="radiogroup" aria-label="Logged by">
              <span>Logged by</span>
              <div className="contributor-toggle">
                {(['you', 'partner'] as const).map((who) => (
                  <button
                    key={who}
                    type="button"
                    role="radio"
                    aria-checked={logContributor === who}
                    className={`contributor-btn contributor-btn-${who} ${logContributor === who ? 'contributor-btn-on' : ''}`}
                    onClick={() => setLogContributor(who)}
                  >
                    Logged by {who === 'you' ? 'You' : 'Partner'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
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
                    <tr
                      key={log.monthKey}
                      className={log.monthKey === lastLogged ? 'log-row-new' : undefined}
                    >
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
  format,
  sub,
  warn = false,
  detail,
}: {
  label: string;
  value: number;
  format: (value: number) => string;
  sub?: string;
  warn?: boolean;
  detail: string;
}) {
  const [open, setOpen] = useState(false);
  const shown = useCountUp(value);
  return (
    <div className={`stat ${open ? 'stat-open' : ''}`}>
      <button
        type="button"
        className="stat-tap"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="stat-label">{label}</span>
        <span className={`stat-value ${warn ? 'stat-warn' : ''}`}>{format(shown)}</span>
        {sub !== undefined ? <span className="stat-sub">{sub}</span> : null}
      </button>
      <p className="stat-detail">{detail}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SVG pieces: ring and trajectory chart                               */
/* ------------------------------------------------------------------ */

function ProgressRing({ ratio }: { ratio: number }) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const [grown, setGrown] = useState(false);

  // Grow the arc from zero whenever the ratio settles or changes, and again
  // whenever the ring is tapped: the CSS transition draws the arc.
  useEffect(() => {
    setGrown(false);
    const timer = window.setTimeout(() => setGrown(true), 50);
    return () => window.clearTimeout(timer);
  }, [clamped]);

  function replay(): void {
    setGrown(false);
    window.setTimeout(() => setGrown(true), 60);
  }

  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const dash = grown ? circumference * clamped : 0;
  const overTarget = ratio >= 1;
  return (
    <button type="button" className="ring ring-btn" onClick={replay} aria-label="Replay the progress arc">
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
    </button>
  );
}

function TrajectoryChart({
  goal,
  elapsed,
  revealed,
}: {
  goal: TrackedGoal;
  elapsed: number;
  revealed: boolean;
}) {
  const series = chartSeries(goal, elapsed);
  // As soon as the partner has logged anything, the single actual line is
  // replaced by the two per-contributor lines from chartSeriesByContributor:
  // both start from the same pot and each carries one person's contributions.
  const hasPartnerLogs = goal.logs.some((log) => log.contributor === 'partner');
  const contributorSeries = hasPartnerLogs ? chartSeriesByContributor(goal, elapsed) : null;
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [selectedContributor, setSelectedContributor] = useState<'you' | 'partner'>('you');
  const plannedPathRef = useRef<SVGPathElement | null>(null);
  const [plannedLength, setPlannedLength] = useState(0);

  useEffect(() => {
    const path = plannedPathRef.current;
    if (path !== null) {
      setPlannedLength(path.getTotalLength());
    }
  }, [series]);

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
  const linePath = (points: Array<{ month: number; balance: number }>): string =>
    points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.month).toFixed(1)},${y(point.balance).toFixed(1)}`)
      .join(' ');
  const actualPath = linePath(series.actual);
  const youPath = contributorSeries !== null ? linePath(contributorSeries.you) : '';
  const partnerPath = contributorSeries !== null ? linePath(contributorSeries.partner) : '';

  const ticks = [0, 0.5, 1].map((fraction) => Math.round((maxValue * fraction) / 100) * 100);
  const ageAt = (month: number): number => goal.startAge + month / 12;

  /** Raw per-contributor sums of the logs dated exactly at this month. */
  const monthSplit = (month: number): { you: number; partner: number } => {
    const split = { you: 0, partner: 0 };
    for (const log of goal.logs) {
      if (monthKeyDiff(goal.startMonthKey, log.monthKey) !== month) {
        continue;
      }
      if (log.contributor === 'partner') {
        split.partner += log.contributedSgd;
      } else {
        split.you += log.contributedSgd;
      }
    }
    return split;
  };

  const selectedPoint =
    selectedMonth === null ? null : series.actual.find((point) => point.month === selectedMonth) ?? null;
  const selectedLogged =
    selectedMonth === null
      ? null
      : goal.logs
          .filter((log) => monthKeyDiff(goal.startMonthKey, log.monthKey) === selectedMonth)
          .reduce((sum, log) => sum + log.contributedSgd, 0);
  const selectedYouPoint =
    contributorSeries !== null && selectedMonth !== null
      ? contributorSeries.you.find((point) => point.month === selectedMonth) ?? null
      : null;
  const selectedPartnerPoint =
    contributorSeries !== null && selectedMonth !== null
      ? contributorSeries.partner.find((point) => point.month === selectedMonth) ?? null
      : null;
  const selectedSplit = selectedMonth === null ? null : monthSplit(selectedMonth);

  function selectDot(month: number, contributor: 'you' | 'partner'): void {
    setSelectedContributor(contributor);
    setSelectedMonth((previous) => (previous === month ? null : month));
  }

  const dotCircles = (points: Array<{ month: number; balance: number }>, who: 'you' | 'partner') =>
    points.map((point, index) => (
      <circle
        key={`${who}-${point.month}`}
        cx={x(point.month)}
        cy={y(point.balance)}
        r={selectedMonth === point.month && selectedContributor === who ? 5 : 3.2}
        className={`chart-dot ${who === 'partner' ? 'chart-dot-partner' : ''} ${revealed ? 'dot-in' : ''}`}
        style={{ transitionDelay: `${300 + index * 45}ms` }}
        role="button"
        tabIndex={0}
        aria-label={`Month ${point.month}, ${who}: ${fmtMoney(point.balance)}`}
        onClick={() => selectDot(point.month, who)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectDot(point.month, who);
          }
        }}
      />
    ));

  return (
    <>
      <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label="Planned savings curve versus actual saved. Tap any dot for that month.">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={padLeft} x2={width - padRight} y1={y(tick)} y2={y(tick)} className="chart-grid" />
            <text x={padLeft - 8} y={y(tick) + 4} className="chart-axis" textAnchor="end">
              {shortMoney(tick)}
            </text>
          </g>
        ))}

        <path d={plannedArea} className={`chart-area ${revealed ? 'chart-area-in' : ''}`} />
        <path
          ref={plannedPathRef}
          d={plannedPath}
          className="chart-planned chart-draw"
          style={{
            strokeDasharray: plannedLength > 0 ? plannedLength : undefined,
            strokeDashoffset: revealed ? 0 : plannedLength,
            transition: 'stroke-dashoffset 1100ms cubic-bezier(0.3, 0.7, 0.2, 1)',
          }}
        />
        <line
          x1={padLeft}
          x2={width - padRight}
          y1={y(goal.targetSgd)}
          y2={y(goal.targetSgd)}
          className={`chart-target ${revealed ? 'chart-late-in' : ''}`}
        />
        <text x={width - padRight} y={y(goal.targetSgd) - 5} className="chart-axis chart-target-label" textAnchor="end">
          target {shortMoney(goal.targetSgd)}
        </text>

        {elapsed > 0 ? (
          <line
            x1={x(elapsed)}
            x2={x(elapsed)}
            y1={padTop}
            y2={padTop + plotHeight}
            className={`chart-now ${revealed ? 'chart-late-in' : ''}`}
          />
        ) : null}

        {contributorSeries !== null ? (
          <>
            {contributorSeries.you.length > 1 ? <path d={youPath} className="chart-actual" /> : null}
            {contributorSeries.partner.length > 1 ? (
              <path d={partnerPath} className="chart-actual chart-actual-partner" />
            ) : null}
            {dotCircles(contributorSeries.you, 'you')}
            {dotCircles(contributorSeries.partner, 'partner')}
          </>
        ) : (
          <>
            {series.actual.length > 1 ? <path d={actualPath} className="chart-actual" /> : null}
            {series.actual.map((point, index) => (
              <circle
                key={point.month}
                cx={x(point.month)}
                cy={y(point.balance)}
                r={selectedMonth === point.month ? 5 : 3.2}
                className={`chart-dot ${revealed ? 'dot-in' : ''}`}
                style={{ transitionDelay: `${300 + index * 45}ms` }}
                role="button"
                tabIndex={0}
                aria-label={`Month ${point.month}: ${fmtMoney(point.balance)}`}
                onClick={() => setSelectedMonth(point.month === selectedMonth ? null : point.month)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelectedMonth(point.month === selectedMonth ? null : point.month);
                  }
                }}
              />
            ))}
          </>
        )}

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
        {contributorSeries !== null ? (
          <>
            <span className="chart-key chart-key-actual">you</span>
            <span className="chart-key chart-key-partner">partner</span>
          </>
        ) : (
          <span className="chart-key chart-key-actual">actual</span>
        )}
        {elapsed > 0 ? <span className="muted chart-now-label">today: month {elapsed}</span> : null}
      </figcaption>
      {contributorSeries !== null &&
      selectedMonth !== null &&
      selectedSplit !== null &&
      selectedYouPoint !== null &&
      selectedPartnerPoint !== null ? (
        <p className="chart-detail" key={`${selectedMonth}-${selectedContributor}`}>
          <span className="strong">Month {selectedMonth}</span> · age{' '}
          {ageAt(selectedMonth).toFixed(1)} · pot + you {fmtMoney(selectedYouPoint.balance)} · pot +
          partner {fmtMoney(selectedPartnerPoint.balance)} · logged that month: you{' '}
          {fmtMoney(selectedSplit.you)} · partner {fmtMoney(selectedSplit.partner)}
          <button
            type="button"
            className="btn btn-ghost btn-small chart-detail-close"
            onClick={() => setSelectedMonth(null)}
          >
            dismiss
          </button>
        </p>
      ) : contributorSeries === null && selectedPoint !== null && selectedLogged !== null ? (
        <p className="chart-detail" key={selectedPoint.month}>
          <span className="strong">Month {selectedPoint.month}</span> · age{' '}
          {ageAt(selectedPoint.month).toFixed(1)} · balance {fmtMoney(selectedPoint.balance)} · logged{' '}
          {fmtMoney(selectedLogged)} that month
          <button
            type="button"
            className="btn btn-ghost btn-small chart-detail-close"
            onClick={() => setSelectedMonth(null)}
          >
            dismiss
          </button>
        </p>
      ) : null}
    </>
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
