'use client';

/**
 * Adviser tab: the conversational spending adviser for the active space.
 *
 * One transcript per space (the page owns the per-space transcript, model-call
 * counter, protected categories and undo snapshots, so switching spaces
 * switches the conversation and nothing is lost). Every turn posts {messages,
 * context, modelCallsUsed} to /api/adviser/chat; the reply's five structured
 * points render in the print transcript and op results become cards:
 *
 * - reduce: the proposal list with per-category freed amounts, the protected
 *   categories editor (toggles persist per space and are respected by the
 *   very next suggestion) and the explicit honesty line that these are
 *   proposed budget savings, not money saved, with no savings log created;
 * - one-off and what-if: a clearly labelled PREVIEW badge with the
 *   before-and-after figures and a shared-pot warning when other tracked
 *   goals exist in the space.
 *
 * Every proposal card carries Preview this change (pure figures only, saved
 * data untouched), Adjust the amount (an inline input that re-runs the op
 * through the route), Compare with my current plan and Apply to my plan.
 * Apply opens a confirmation naming exactly what changes, in which space and
 * for which goal, then updates plan settings through the existing setters
 * while every contribution log survives; a one-step Undo per space restores
 * the pre-apply snapshot. Local mode is honest: an unsupported turn under the
 * fallback engine renders the limitation with actionable phrasing chips, and
 * nothing ever fakes a model reply.
 */
import { useEffect, useRef, useState } from 'react';

import { CATEGORY_LABELS } from '../../lib/adviser/ops';
import { MAX_HISTORY_MESSAGES } from '../../lib/adviser/limits';
import { monthsToTarget, type TrackedGoal } from '../../lib/planner/progress';
import type { GoalSpec, UserProfile } from '../../lib/planner/goalspec';
import type { ExpenseCategory } from '../../lib/cards/types';

import {
  CATEGORIES,
  fmtMoney,
  isAdviserChatReply,
  previewReduceEffect,
  spaceLabel,
  summarizeLedgerMonths,
  type AdviserChatDetail,
  type AdviserChatReply,
  type LedgerRow,
  type SpaceId,
  type StatusJson,
} from './shared';

/** One completed turn of a space's transcript. */
export interface AdviserExchange {
  userText: string;
  reply: AdviserChatReply | null;
  error: string | null;
}

/** The starter actions; each seeds a first turn the offline classifier parses. */
const STARTERS: ReadonlyArray<{ label: string; message: string }> = [
  { label: 'Review my spending', message: 'Where is my money going?' },
  { label: 'Help me save more', message: 'Help me trim my spending' },
  { label: 'Explore a what-if', message: 'What if I stop working for 6 months?' },
];

/** Phrasings the offline classifier understands, offered when it had to refuse. */
const SUPPORTED_PHRASINGS: ReadonlyArray<string> = [
  'Where is my money going?',
  'Compare last month with this month',
  'Reduce dining by 200',
  'How can I save another 300 monthly',
  'What does a 3000 one-off expense do to my goal',
  'What if I stop working for 6 months',
  'Do not touch groceries',
];

/** The no-records phrase the route's honest needs-data replies carry. */
const NEEDS_DATA_MARKER = 'no month with logged records';

interface AdviserTabProps {
  space: SpaceId;
  profile: UserProfile;
  ledger: LedgerRow[];
  goals: TrackedGoal[];
  walletNames: string[];
  protectedCategories: ExpenseCategory[];
  onToggleProtected: (space: SpaceId, category: ExpenseCategory) => void;
  onProtect: (space: SpaceId, category: ExpenseCategory) => void;
  transcript: AdviserExchange[];
  modelCallsUsed: number;
  onTurnComplete: (space: SpaceId, exchange: AdviserExchange) => void;
  onModelCalls: (space: SpaceId, used: number) => void;
  onUpdateProfileField: (field: 'monthlyExpenses' | 'liquidSavings', raw: string) => void;
  onReviseGoal: (space: SpaceId, goalId: string, revisedGoalSpec: GoalSpec) => void;
  onCaptureUndo: (space: SpaceId) => void;
  onUndo: (space: SpaceId) => void;
  undoAvailable: boolean;
  /** Connection truth for the honest header note; null while pending. */
  connection: StatusJson['connection'] | null;
  /** A question seeded from elsewhere (the dashboard's contextual adviser). */
  initialQuestion?: string;
  /** Clears initialQuestion at the source once it has been sent. */
  onInitialQuestionConsumed?: () => void;
  /** The goal the dashboard has selected, carried into this conversation. */
  selectedGoalId?: string | null;
}

/** "3 months" / "1 month" or the honest unknown. */
function monthsWords(months: number | null): string {
  if (months === null) {
    return 'never lands';
  }
  return `${months} month${months === 1 ? '' : 's'}`;
}

/** Message the Adjust re-run sends for an adjustable op, or null when fixed. */
function adjustMessageFor(detail: AdviserChatDetail, amount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  if (detail.kind === 'reduce') {
    return detail.namedCategory !== undefined
      ? `Reduce ${CATEGORY_LABELS[detail.namedCategory]} by ${amount}`
      : `How can I save another ${amount} monthly`;
  }
  if (detail.kind === 'one_off') {
    return `What does a ${amount} one-off expense do to my goal`;
  }
  if (detail.patchKind === 'incomeGap') {
    return `What if I stop working for ${amount} months`;
  }
  return null;
}

export function AdviserTab({
  space,
  profile,
  ledger,
  goals,
  walletNames,
  protectedCategories,
  onToggleProtected,
  onProtect,
  transcript,
  modelCallsUsed,
  onTurnComplete,
  onModelCalls,
  onUpdateProfileField,
  onReviseGoal,
  onCaptureUndo,
  onUndo,
  undoAvailable,
  connection,
  initialQuestion,
  onInitialQuestionConsumed,
  selectedGoalId,
}: AdviserTabProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** Which panel each exchange has open: preview, compare or the apply confirmation. */
  const [openPanel, setOpenPanel] = useState<Record<number, 'preview' | 'compare' | 'apply' | null>>({});
  /** Adjust inputs keyed by exchange index. */
  const [adjustDrafts, setAdjustDrafts] = useState<Record<number, string>>({});
  /** Exchanges whose proposal was applied. */
  const [applied, setApplied] = useState<Record<number, boolean>>({});

  const selectedGoal =
    (selectedGoalId !== undefined && selectedGoalId !== null
      ? goals.find((goal) => goal.id === selectedGoalId)
      : undefined) ?? (goals.length === 1 ? goals[0] : undefined);

  // A question seeded from the dashboard sends exactly once, on mount or when
  // it changes to a fresh non-empty value.
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialQuestion === undefined || initialQuestion === '' || seededRef.current === initialQuestion) {
      return;
    }
    seededRef.current = initialQuestion;
    onInitialQuestionConsumed?.();
    void send(initialQuestion);
    // send is stable enough for this one-shot; the effect deliberately runs
    // only on initialQuestion changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);


  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '' || sending) {
      return;
    }
    setSending(true);
    setDraft('');
    // History for the classifier: prior user turns plus adviser replies,
    // trimmed to the newest MAX_HISTORY_MESSAGES entries per the limits module.
    const history: Array<{ role: 'user' | 'advisor'; text: string }> = [];
    for (const exchange of transcript) {
      history.push({ role: 'user', text: exchange.userText });
      if (exchange.reply !== null) {
        history.push({ role: 'advisor', text: exchange.reply.reply });
      } else if (exchange.error !== null) {
        history.push({ role: 'advisor', text: exchange.error });
      }
    }
    history.push({ role: 'user', text: trimmed });
    const messages = history.slice(-MAX_HISTORY_MESSAGES);
    // The exchange belongs to the space it was asked in, even if the user
    // switches spaces while the request is in flight.
    const requestSpace = space;
    try {
      const response = await fetch('/api/adviser/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          modelCallsUsed,
          context: {
            profile,
            walletNames,
            ledgerAvailable: { months: summarizeLedgerMonths(ledger) },
            goalSummaries: goals.map((goal) => ({
              id: goal.id,
              name: goal.name,
              space: goal.space,
              deadlineAge: goal.deadlineAge,
            })),
            protectedCategories,
            ledger,
            goals,
            ...(selectedGoal !== undefined ? { selectedGoalId: selectedGoal.id } : {}),
          },
        }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const message =
          data !== null &&
          typeof data === 'object' &&
          'error' in data &&
          typeof (data as { error: unknown }).error === 'string'
            ? (data as { error: string }).error
            : `The adviser request failed with status ${response.status}.`;
        onTurnComplete(requestSpace, { userText: trimmed, reply: null, error: message });
        return;
      }
      if (!isAdviserChatReply(data)) {
        onTurnComplete(requestSpace, {
          userText: trimmed,
          reply: null,
          error: 'The adviser returned an unexpected reply shape.',
        });
        return;
      }
      onModelCalls(requestSpace, data.meta.modelCallsUsed);
      // A protect_category op protects immediately through the stored prefs,
      // so later reduce suggestions in this space already respect it.
      if (data.action?.type === 'protect_category') {
        onProtect(requestSpace, data.action.category);
      }
      onTurnComplete(requestSpace, { userText: trimmed, reply: data, error: null });
    } catch {
      onTurnComplete(requestSpace, {
        userText: trimmed,
        reply: null,
        error: 'Could not reach the adviser API. Check that the server is running.',
      });
    } finally {
      setSending(false);
    }
  }

  /** Apply a confirmed proposal through the existing setters, after snapshotting. */
  function applyProposal(index: number, detail: AdviserChatDetail): void {
    if (detail.kind === 'reduce') {
      if (space === 'us' || !(detail.freedMonthly > 0)) {
        return;
      }
      onCaptureUndo(space);
      onUpdateProfileField(
        'monthlyExpenses',
        String(Math.max(0, Math.round((profile.monthlyExpenses - detail.freedMonthly) * 100) / 100))
      );
    } else if (detail.kind === 'one_off') {
      if (space === 'us') {
        return;
      }
      onCaptureUndo(space);
      onUpdateProfileField(
        'liquidSavings',
        String(Math.max(0, Math.round((profile.liquidSavings - detail.amountSgd) * 100) / 100))
      );
    } else {
      if (detail.patchKind === 'incomeGap' && space === 'us') {
        return;
      }
      onCaptureUndo(space);
      if (detail.patchKind === 'incomeGap') {
        onUpdateProfileField(
          'liquidSavings',
          String(Math.max(0, Math.round(detail.revisedProfile.liquidSavings * 100) / 100))
        );
      } else {
        onReviseGoal(space, detail.goalId, detail.revisedGoalSpec);
      }
    }
    setApplied((previous) => ({ ...previous, [index]: true }));
    setOpenPanel((previous) => ({ ...previous, [index]: null }));
  }

  const offlineNote =
    connection === 'verified'
      ? 'Nemotron answers when it can; the deterministic engine is always the floor.'
      : connection === 'configured'
        ? 'A key is configured but unverified, so turns may land on the deterministic fallback.'
        : 'Local mode: every turn is answered by the deterministic fallback engine offline.';

  return (
    <div className="stack">
      <section className="card adviser-tab-card" aria-label="Spending adviser">
        <div className="card-title-row">
          <h2 className="card-title">Adviser</h2>
          <span className="engine-badge engine-badge-neutral" title={offlineNote}>
            {connection === 'verified' ? 'Nemotron when it can' : 'Local floor always on'}
          </span>
        </div>
        <div className="chip-row adviser-space-row">
          <span className="assumption-chip adviser-space-chip">
            <span className="assumption-value">
              This conversation is about: {spaceLabel(space)}
            </span>
            <span className="assumption-reason">
              Switching spaces switches the transcript; each space keeps its own conversation and
              its own protected categories.
            </span>
          </span>
        </div>
        {undoAvailable ? (
          <div className="undo-banner" role="status">
            <span>
              Plan settings were changed from this conversation. Undo restores the pre-apply
              snapshot for {spaceLabel(space)}.
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => onUndo(space)}
            >
              Undo apply
            </button>
          </div>
        ) : null}

        <div className="advisor-log adviser-log">
          {transcript.map((exchange, index) => {
            const reply = exchange.reply;
            const detail = reply?.detail;
            return (
              <div key={index} className="advisor-exchange">
                <div className="advisor-line advisor-line-user">
                  <span className="advisor-line-role">You</span>
                  <p className="advisor-line-body">{exchange.userText}</p>
                </div>
                <div className="advisor-line">
                  <span className="advisor-line-role">Adviser</span>
                  <div className="advisor-line-body">
                    {exchange.error !== null ? (
                      <p className="error-text">{exchange.error}</p>
                    ) : reply !== null ? (
                      <>
                        <span
                          className={`engine-badge ${reply.engine === 'model' ? 'engine-badge-ultra' : 'engine-badge-neutral'}`}
                        >
                          {reply.engine === 'model' ? 'Nemotron' : 'Local fallback'}
                        </span>
                        {reply.reply.includes(NEEDS_DATA_MARKER) ? (
                          <span className="pill pill-warn needs-data-pill">Needs data</span>
                        ) : null}
                        <dl className="adviser-points">
                          {reply.points.map((point) => (
                            <div key={point.label} className="adviser-point">
                              <dt>{point.label}</dt>
                              <dd>{point.body}</dd>
                            </div>
                          ))}
                        </dl>
                        {reply.op === 'unsupported' && reply.engine === 'fallback' ? (
                          <div className="adviser-op-card">
                            <p className="adviser-honesty-line">
                              The offline adviser understood nothing it can act on. It supports a
                              fixed set of phrasings; tap one to try it.
                            </p>
                            <div className="chip-row">
                              {SUPPORTED_PHRASINGS.map((phrasing) => (
                                <button
                                  key={phrasing}
                                  type="button"
                                  className="example-chip"
                                  disabled={sending}
                                  onClick={() => void send(phrasing)}
                                >
                                  {phrasing}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {detail !== undefined ? (
                          <OpCard
                            index={index}
                            detail={detail}
                            space={space}
                            goals={goals}
                            selectedGoal={selectedGoal}
                            protectedCategories={protectedCategories}
                            onToggleProtected={onToggleProtected}
                            sending={sending}
                            panel={openPanel[index] ?? null}
                            onPanel={(next) =>
                              setOpenPanel((previous) => ({
                                ...previous,
                                [index]: previous[index] === next ? null : next,
                              }))
                            }
                            adjustDraft={adjustDrafts[index] ?? ''}
                            onAdjustDraft={(value) =>
                              setAdjustDrafts((previous) => ({ ...previous, [index]: value }))
                            }
                            onAdjustRun={(message) => void send(message)}
                            applied={applied[index] === true}
                            onApply={() => {
                              const current = reply?.detail;
                              if (current !== undefined) {
                                applyProposal(index, current);
                              }
                            }}
                            profile={profile}
                          />
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <form
          className="adviser-form adviser-form-row"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <input
            className="advisor-input"
            type="text"
            value={draft}
            placeholder="Ask about your spending or your goals..."
            aria-label="Message the spending adviser"
            disabled={sending}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={sending || draft.trim() === ''}
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
        </form>
        <div className="chip-row advisor-chips">
          {STARTERS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              className="example-chip"
              disabled={sending}
              onClick={() => void send(starter.message)}
            >
              {starter.label}
            </button>
          ))}
        </div>
        <p className="muted source-note">{offlineNote}</p>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Op result cards                                                         */
/* ---------------------------------------------------------------------- */

interface OpCardProps {
  index: number;
  detail: AdviserChatDetail;
  space: SpaceId;
  goals: TrackedGoal[];
  selectedGoal: TrackedGoal | undefined;
  protectedCategories: ExpenseCategory[];
  onToggleProtected: (space: SpaceId, category: ExpenseCategory) => void;
  sending: boolean;
  panel: 'preview' | 'compare' | 'apply' | null;
  onPanel: (next: 'preview' | 'compare' | 'apply') => void;
  adjustDraft: string;
  onAdjustDraft: (value: string) => void;
  onAdjustRun: (message: string) => void;
  applied: boolean;
  onApply: () => void;
  profile: UserProfile;
}

function OpCard(props: OpCardProps) {
  const { detail, space, selectedGoal, protectedCategories, onToggleProtected, profile } = props;
  if (detail.kind === 'reduce') {
    const nextExpenses = Math.max(0, Math.round((profile.monthlyExpenses - detail.freedMonthly) * 100) / 100);
    return (
      <div className="adviser-op-card">
        <h4 className="adviser-card-head">Proposed budget cuts for {detail.monthKey}</h4>
        <div className="table-scroll">
          <table className="table adviser-proposal-table">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Logged this month</th>
                <th className="num">Proposed cut</th>
                <th className="num">Freed per month</th>
              </tr>
            </thead>
            <tbody>
              {detail.proposals.map((proposal) => (
                <tr key={proposal.category}>
                  <td className="strong">{CATEGORY_LABELS[proposal.category]}</td>
                  <td className="num">{fmtMoney(proposal.monthTotal)}</td>
                  <td className="num">{fmtMoney(proposal.proposedCut)}</td>
                  <td className="num strong">{fmtMoney(proposal.freedMonthly)}</td>
                </tr>
              ))}
              <tr>
                <td className="strong">Total</td>
                <td className="num muted" />
                <td className="num muted" />
                <td className="num strong">{fmtMoney(detail.freedMonthly)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="adviser-honesty-line">
          These are proposed budget savings, not money saved. Nothing is logged or moved until you
          change your own plan; no savings log is ever created from this card.
        </p>
        <ProtectedEditor
          space={space}
          protectedCategories={protectedCategories}
          onToggleProtected={onToggleProtected}
        />
        <ActionRow
          {...props}
          adjustLabel={
            detail.namedCategory !== undefined ? 'Cut per month (S$)' : 'Free per month (S$)'
          }
          applyKind="reduce"
          applySummary={
            space === 'us'
              ? undefined
              : `Monthly expenses: ${fmtMoney(profile.monthlyExpenses)} to ${fmtMoney(nextExpenses)} (planned expenses only; contribution history untouched).`
          }
        />
        {props.panel === 'preview' ? (
          <PreviewPanel detail={detail} selectedGoal={selectedGoal} />
        ) : null}
        {props.panel === 'compare' ? (
          <ComparePanel detail={detail} selectedGoal={selectedGoal} profile={profile} />
        ) : null}
      </div>
    );
  }
  const sharedPotWarning = detail.kind === 'one_off' ? detail.sharedPotWarning : props.goals.length > 1;
  return (
    <div className="adviser-op-card adviser-preview-card">
      <div className="adviser-preview-head">
        <span className="preview-badge">Preview</span>
        <h4 className="adviser-card-head">
          {detail.kind === 'one_off'
            ? `One-off ${fmtMoney(detail.amountSgd)} against ${detail.goalName}`
            : `What-if on ${detail.goalName}`}
        </h4>
      </div>
      <div className="advisor-diff adviser-before-after">
        <div className="advisor-diff-col">
          <span className="advisor-diff-head">Before</span>
          <div className="advisor-diff-cell">
            <span className="stat-label">
              {detail.kind === 'one_off' ? 'Goal pot at tracking' : 'Liquid savings'}
            </span>
            <span className="money strong">
              {fmtMoney(detail.kind === 'one_off' ? detail.potBefore : detail.savingsBefore)}
            </span>
          </div>
          <div className="advisor-diff-cell">
            <span className="stat-label">Finish</span>
            <span className="money strong">
              {detail.kind === 'one_off'
                ? monthsWords(detail.monthsBefore)
                : goalDeadlineLabel(props.goals, detail.goalId)}
            </span>
          </div>
        </div>
        <div className="advisor-diff-col">
          <span className="advisor-diff-head">After (preview only)</span>
          <div className="advisor-diff-cell">
            <span className="stat-label">
              {detail.kind === 'one_off'
                ? 'Goal pot after the expense'
                : 'Liquid savings after the change'}
            </span>
            <span className="money strong">
              {fmtMoney(detail.kind === 'one_off' ? detail.potAfter : detail.savingsAfter)}
            </span>
          </div>
          <div className="advisor-diff-cell">
            <span className="stat-label">Finish</span>
            <span className="money strong">
              {detail.kind === 'one_off'
                ? monthsWords(detail.monthsAfter)
                : `age ${detail.revisedGoalSpec.deadlineAge}`}
            </span>
          </div>
        </div>
      </div>
      {sharedPotWarning ? (
        <p className="adviser-honesty-line shared-pot-warning">
          Shared-pot warning: other tracked goals share this space&rsquo;s savings. The same money
          cannot fund two goals at once.
        </p>
      ) : null}
      <ActionRow
        {...props}
        adjustLabel={
          detail.kind === 'one_off'
            ? 'Expense amount (S$)'
            : detail.patchKind === 'incomeGap'
              ? 'Months without income'
              : undefined
        }
        applyKind={detail.kind === 'one_off' ? 'one_off' : 'what_if'}
        applySummary={applySummaryFor(detail, space, profile, props.goals)}
      />
      {props.panel === 'preview' ? (
        <PreviewPanel detail={detail} selectedGoal={selectedGoal} />
      ) : null}
      {props.panel === 'compare' ? (
        <ComparePanel detail={detail} selectedGoal={selectedGoal} profile={profile} />
      ) : null}
    </div>
  );
}

/** The exact sentence the apply confirmation shows for one-off and what-if ops. */
function applySummaryFor(
  detail: Extract<AdviserChatDetail, { kind: 'one_off' }> | Extract<AdviserChatDetail, { kind: 'what_if' }>,
  space: SpaceId,
  profile: UserProfile,
  goals: ReadonlyArray<TrackedGoal>
): string | undefined {
  if (detail.kind === 'one_off') {
    return space === 'us'
      ? undefined
      : `Liquid savings: ${fmtMoney(profile.liquidSavings)} to ${fmtMoney(
          Math.max(0, profile.liquidSavings - detail.amountSgd)
        )} (the one-off paid from savings; contribution history untouched).`;
  }
  if (detail.patchKind === 'incomeGap') {
    return space === 'us'
      ? undefined
      : `Liquid savings: ${fmtMoney(detail.savingsBefore)} to ${fmtMoney(
          Math.max(0, detail.savingsAfter)
        )} (the modelled runway burn; contribution history untouched).`;
  }
  const goal = goals.find((entry) => entry.id === detail.goalId);
  if (goal === undefined) {
    return undefined;
  }
  return `Goal ${goal.name}: deadline age ${goal.deadlineAge} to ${detail.revisedGoalSpec.deadlineAge}, with every savings log kept.`;
}

function goalDeadlineLabel(goals: ReadonlyArray<TrackedGoal>, goalId: string): string {
  const goal = goals.find((entry) => entry.id === goalId);
  return goal === undefined ? 'unknown goal' : `age ${goal.deadlineAge}`;
}

/** Chips the user toggles any time; persisted per space by the page. */
function ProtectedEditor({
  space,
  protectedCategories,
  onToggleProtected,
}: {
  space: SpaceId;
  protectedCategories: ExpenseCategory[];
  onToggleProtected: (space: SpaceId, category: ExpenseCategory) => void;
}) {
  return (
    <div className="adviser-protected">
      <span className="adviser-protected-label">
        Protected categories (never proposed for cuts, stored for {spaceLabel(space)})
      </span>
      <div className="chip-row protected-chip-row">
        {CATEGORIES.map((entry) => {
          const on = protectedCategories.includes(entry.value);
          return (
            <button
              key={entry.value}
              type="button"
              className={`protected-chip ${on ? 'protected-chip-on' : ''}`}
              aria-pressed={on}
              onClick={() => onToggleProtected(space, entry.value)}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The four reviewable actions shared by every proposal card. */
function ActionRow({
  detail,
  space,
  sending,
  panel,
  onPanel,
  adjustDraft,
  onAdjustDraft,
  onAdjustRun,
  applied,
  onApply,
  goals,
  adjustLabel,
  applyKind,
  applySummary,
}: OpCardProps & {
  adjustLabel?: string;
  applyKind: 'reduce' | 'one_off' | 'what_if';
  applySummary: string | undefined;
}) {
  const amount = Number(adjustDraft);
  const reRunMessage = adjustMessageFor(detail, amount);
  return (
    <div className="adviser-actions adviser-card-actions">
      <button type="button" className="btn btn-secondary btn-small" onClick={() => onPanel('preview')}>
        {panel === 'preview' ? 'Hide preview' : 'Preview this change'}
      </button>
      {adjustLabel !== undefined ? (
        <span className="adviser-adjust">
          <label className="takehome-edit-label" htmlFor={`adjust-${applyKind}`}>
            {adjustLabel}
          </label>
          <input
            id={`adjust-${applyKind}`}
            type="number"
            min={0}
            step={10}
            value={adjustDraft}
            placeholder="new amount"
            onChange={(event) => onAdjustDraft(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={sending || reRunMessage === null}
            onClick={() => {
              if (reRunMessage !== null) {
                onAdjustRun(reRunMessage);
              }
            }}
          >
            Re-run
          </button>
        </span>
      ) : null}
      <button type="button" className="btn btn-secondary btn-small" onClick={() => onPanel('compare')}>
        {panel === 'compare' ? 'Hide comparison' : 'Compare with my current plan'}
      </button>
      {applied ? (
        <span className="pill pill-pass">Applied to your plan</span>
      ) : applySummary !== undefined ? (
        <button type="button" className="btn btn-primary btn-small" onClick={() => onPanel('apply')}>
          Apply to my plan
        </button>
      ) : (
        <span className="muted adviser-apply-blocked">
          Apply needs an editable profile in this space
        </span>
      )}
      {panel === 'apply' && applySummary !== undefined ? (
        <div className="adviser-confirm" role="alertdialog" aria-label="Confirm applying this change">
          <p className="strong">Apply this change?</p>
          <p>{applySummary}</p>
          <p className="muted">
            Space: {spaceLabel(space)}. Goal:{' '}
            {goals.length === 1 ? (goals[0] as TrackedGoal).name : 'none selected'}. Plan settings
            update through your existing profile form and tracked goals; every contribution log is
            preserved. You can undo this once from the banner above the transcript.
          </p>
          <div className="adviser-actions">
            <button type="button" className="btn btn-primary btn-small" onClick={onApply}>
              Confirm and apply
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => onPanel('apply')}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Pure figures only: a preview never mutates saved data. */
function PreviewPanel({
  detail,
  selectedGoal,
}: {
  detail: AdviserChatDetail;
  selectedGoal: TrackedGoal | undefined;
}) {
  if (detail.kind === 'reduce') {
    if (selectedGoal === undefined) {
      return (
        <p className="adviser-honesty-line">
          Preview: exactly one tracked goal in this space is needed to project the freed cash onto
          it. Nothing was changed.
        </p>
      );
    }
    const figures = previewReduceEffect(selectedGoal, detail.freedMonthly);
    return (
      <div className="adviser-preview-panel">
        <p className="strong">
          Preview: redirecting {fmtMoney(detail.freedMonthly)} a month into {selectedGoal.name}
        </p>
        <p>
          Finish moves from {monthsWords(figures.monthsBefore)} to {monthsWords(figures.monthsAfter)}.
          Nothing was changed; this is a projection at the goal&rsquo;s frozen rates.
        </p>
      </div>
    );
  }
  return (
    <div className="adviser-preview-panel">
      <p className="strong">Preview only: nothing below has been applied.</p>
      {detail.kind === 'one_off' ? (
        <p>
          The figures above come from re-solving the goal at its frozen pace with the one-off
          removed from the pot. Your saved plan, profile and logs are untouched.
        </p>
      ) : (
        <p>
          The figures above come from applying the revision deterministically in memory. Your saved
          plan, profile and logs are untouched until you press Apply.
        </p>
      )}
    </div>
  );
}

/** Current plan versus the proposal, all figures from pure functions. */
function ComparePanel({
  detail,
  selectedGoal,
  profile,
}: {
  detail: AdviserChatDetail;
  selectedGoal: TrackedGoal | undefined;
  profile: UserProfile;
}) {
  if (selectedGoal === undefined) {
    return (
      <p className="adviser-honesty-line">
        Comparison needs exactly one tracked goal in this space. Nothing was changed.
      </p>
    );
  }
  const months = monthsToTarget(
    selectedGoal.startSavingsSgd,
    selectedGoal.ratePa,
    selectedGoal.requiredMonthlySgd,
    selectedGoal.targetSgd
  );
  let proposalLine: string;
  if (detail.kind === 'reduce') {
    const figures = previewReduceEffect(selectedGoal, detail.freedMonthly);
    proposalLine = `Proposal: keep the plan as it is, but redirecting ${fmtMoney(detail.freedMonthly)} a month of planned spending would finish in ${monthsWords(figures.monthsAfter)}.`;
  } else if (detail.kind === 'one_off') {
    proposalLine = `Proposal: the one-off ${fmtMoney(detail.amountSgd)} pushes the finish to ${monthsWords(detail.monthsAfter)}.`;
  } else {
    proposalLine = `Proposal: revised goal ${describeSpecShort(detail.revisedGoalSpec)} with liquid savings modelled at ${fmtMoney(detail.savingsAfter)}.`;
  }
  return (
    <div className="adviser-preview-panel">
      <p className="strong">Current plan: {selectedGoal.name}</p>
      <p>
        Required {fmtMoney(selectedGoal.requiredMonthlySgd)} a month, target{' '}
        {fmtMoney(selectedGoal.targetSgd)} by age {selectedGoal.deadlineAge}, finishing in{' '}
        {monthsWords(months)}. Planned expenses today: {fmtMoney(profile.monthlyExpenses)} a month.
      </p>
      <p>{proposalLine}</p>
      <p className="muted">Every figure above is computed by the deterministic kernels.</p>
    </div>
  );
}

function describeSpecShort(goal: GoalSpec): string {
  if (goal.kind === 'property_purchase') {
    return `property at ${fmtMoney(goal.targetPriceSgd)} by age ${goal.deadlineAge}`;
  }
  if (goal.kind === 'car_purchase') {
    return `car at ${fmtMoney(goal.priceSgd)} by age ${goal.deadlineAge}`;
  }
  return `save ${fmtMoney(goal.targetAmountSgd)} by age ${goal.deadlineAge}`;
}
