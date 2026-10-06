'use client';

/**
 * What-if advisor: a compact conversation column under the rendered plan.
 *
 * Every turn posts the whole transcript plus the current goal spec and
 * planning profile to /api/advisor and renders one of the three reply shapes:
 * clarify questions as a numbered prompt the user answers through the same
 * input, an answer as a plain advisor line, and a revise as a before-and-after
 * comparison block whose numbers all come from the server's deterministic
 * kernels. Apply stores the revised goal spec and profile into the planner
 * state through the parent; Keep leaves the block as a read-only reference.
 * The transcript is print, not chat: role labels and hairline separators, no
 * bubbles, and the whole flow works offline through the fallback classifier.
 */
import { useEffect, useState } from 'react';

import type { GoalSpec, UserProfile } from '../../lib/planner/goalspec';

import {
  fmtMoney,
  isAdvisorReply,
  type AdvisorReply,
  type SpaceId,
  type StatusJson,
} from './shared';

interface AdvisorCardProps {
  space: SpaceId;
  goalSpec: GoalSpec;
  /** The profile the plan was built on: personal in You and Partner, combined in Us. */
  profile: UserProfile;
  /** /api/status connection truth, used to label the answering engine honestly. */
  connection: StatusJson['connection'] | null;
  onApplyRevision: (goalSpec: GoalSpec, profile: UserProfile) => void;
}

/** One user message and whatever came back, kept in the transcript even on error. */
interface AdvisorExchange {
  userText: string;
  reply: AdvisorReply | null;
  error: string | null;
  /** Set once the user pressed Apply or Keep as reference on a revise block. */
  resolved: 'applied' | 'reference' | null;
}

const STARTER_CHIPS: ReadonlyArray<string> = [
  'Can we afford this flat?',
  'What if my partner stops working for 6 months?',
  'What if we buy 2 years later?',
];

function verdictPill(status: string): { className: string; label: string } {
  if (status === 'achievable') {
    return { className: 'pill pill-pass', label: 'Achievable' };
  }
  if (status === 'stretch') {
    return { className: 'pill pill-warn', label: 'Stretch' };
  }
  return { className: 'pill pill-fail', label: 'Not achievable' };
}

/** The advisor-side text of a reply, replayed back into the next request. */
function advisorText(reply: AdvisorReply): string {
  if (reply.kind === 'clarify') {
    return reply.questions.map((question, index) => `${index + 1}. ${question}`).join(' ');
  }
  return reply.summary;
}

export function AdvisorCard({
  space,
  goalSpec,
  profile,
  connection,
  onApplyRevision,
}: AdvisorCardProps) {
  const [exchanges, setExchanges] = useState<AdvisorExchange[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  // A new goal spec (re-plan or an applied revision) starts a fresh
  // conversation: old turns referred to numbers that no longer stand.
  useEffect(() => {
    setExchanges([]);
  }, [goalSpec]);

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '' || sending) {
      return;
    }
    setSending(true);
    setDraft('');
    const messages = [
      ...exchanges.flatMap((exchange): Array<{ role: 'user' | 'advisor'; text: string }> => {
        const rows: Array<{ role: 'user' | 'advisor'; text: string }> = [
          { role: 'user', text: exchange.userText },
        ];
        if (exchange.reply !== null) {
          rows.push({ role: 'advisor' as const, text: advisorText(exchange.reply) });
        } else if (exchange.error !== null) {
          rows.push({ role: 'advisor' as const, text: exchange.error });
        }
        return rows;
      }),
      { role: 'user' as const, text: trimmed },
    ];
    try {
      const response = await fetch('/api/advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, goalSpec, profile }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const message =
          data !== null && typeof data === 'object' && 'error' in data
            ? String((data as { error: unknown }).error)
            : `The advisor request failed with status ${response.status}.`;
        setExchanges((previous) => [...previous, { userText: trimmed, reply: null, error: message, resolved: null }]);
        return;
      }
      if (!isAdvisorReply(data)) {
        setExchanges((previous) => [
          ...previous,
          {
            userText: trimmed,
            reply: null,
            error: 'The advisor returned an unexpected reply shape.',
            resolved: null,
          },
        ]);
        return;
      }
      setExchanges((previous) => [...previous, { userText: trimmed, reply: data, error: null, resolved: null }]);
    } catch {
      setExchanges((previous) => [
        ...previous,
        {
          userText: trimmed,
          reply: null,
          error: 'Could not reach the advisor API. Check that the server is running.',
          resolved: null,
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  function resolve(index: number, outcome: 'applied' | 'reference'): void {
    if (outcome === 'applied') {
      const exchange = exchanges[index];
      if (exchange?.reply?.kind === 'revise') {
        onApplyRevision(exchange.reply.revisedGoalSpec, exchange.reply.revisedProfile);
      }
    }
    setExchanges((previous) =>
      previous.map((exchange, index_) => (index_ === index ? { ...exchange, resolved: outcome } : exchange))
    );
  }

  const badge =
    connection === 'verified'
      ? { className: 'engine-badge engine-badge-ultra', label: 'Advisor by Nemotron' }
      : connection === 'configured'
        ? { className: 'engine-badge engine-badge-neutral', label: 'Advisor, Nemotron unverified' }
        : { className: 'engine-badge engine-badge-neutral', label: 'Offline advisor' };

  return (
    <section className="card advisor-card" aria-label="What-if advisor">
      <div className="card-title-row">
        <h3 className="card-title">What-if advisor</h3>
        <span
          className={badge.className}
          title="Nemotron answers when a key is configured and the endpoint responds; the deterministic classifier is always the floor, so every turn works offline."
        >
          {badge.label}
        </span>
      </div>
      <p className="muted source-note">
        Ask a what-if about the plan above. A revision re-runs the deterministic kernels before and
        after, so every number below is computed, never guessed.
      </p>

      <div className="advisor-log">
        {exchanges.map((exchange, index) => (
          <div key={index} className="advisor-exchange">
            <div className="advisor-line advisor-line-user">
              <span className="advisor-line-role">You</span>
              <p className="advisor-line-body">{exchange.userText}</p>
            </div>
            {exchange.error !== null ? (
              <div className="advisor-line">
                <span className="advisor-line-role">Advisor</span>
                <p className="advisor-line-body error-text">{exchange.error}</p>
              </div>
            ) : exchange.reply !== null ? (
              <div className="advisor-line">
                <span className="advisor-line-role">Advisor</span>
                <div className="advisor-line-body">
                  {exchange.reply.kind === 'clarify' ? (
                    <ol className="advisor-questions">
                      {exchange.reply.questions.map((question) => (
                        <li key={question}>{question}</li>
                      ))}
                    </ol>
                  ) : (
                    <p className="advisor-summary">{exchange.reply.summary}</p>
                  )}
                  {exchange.reply.kind === 'revise' ? (
                    <ReviseBlock
                      reply={exchange.reply}
                      resolved={exchange.resolved}
                      isUsSpace={space === 'us'}
                      onApply={() => resolve(index, 'applied')}
                      onKeep={() => resolve(index, 'reference')}
                    />
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <form
        className="advisor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <input
          className="advisor-input"
          type="text"
          value={draft}
          placeholder="Ask a what-if, or answer a numbered question..."
          aria-label="Message the what-if advisor"
          disabled={sending}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={sending || draft.trim() === ''}>
          {sending ? 'Sending...' : 'Send'}
        </button>
      </form>
      <div className="chip-row advisor-chips">
        {STARTER_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            className="example-chip"
            disabled={sending}
            onClick={() => void send(chip)}
          >
            {chip}
          </button>
        ))}
      </div>
    </section>
  );
}

function ReviseBlock({
  reply,
  resolved,
  isUsSpace,
  onApply,
  onKeep,
}: {
  reply: Extract<AdvisorReply, { kind: 'revise' }>;
  resolved: 'applied' | 'reference' | null;
  isUsSpace: boolean;
  onApply: () => void;
  onKeep: () => void;
}) {
  const before = verdictPill(reply.delta.verdictBefore);
  const after = verdictPill(reply.delta.verdictAfter);
  return (
    <div className="advisor-revise">
      <div className="advisor-diff">
        <div className="advisor-diff-col">
          <span className="advisor-diff-head">Before</span>
          <div className="advisor-diff-cell">
            <span className="stat-label">Required monthly</span>
            <span className="money strong">{fmtMoney(reply.delta.requiredMonthlySavingsBefore)}</span>
          </div>
          <div className="advisor-diff-cell">
            <span className="stat-label">Verdict</span>
            <span className={before.className}>{before.label}</span>
          </div>
          <div className="advisor-diff-cell">
            <span className="stat-label">Target</span>
            <span className="money strong">{fmtMoney(reply.delta.targetBefore)}</span>
          </div>
        </div>
        <div className="advisor-diff-col">
          <span className="advisor-diff-head">After</span>
          <div className="advisor-diff-cell">
            <span className="stat-label">Required monthly</span>
            <span className="money strong">{fmtMoney(reply.delta.requiredMonthlySavingsAfter)}</span>
          </div>
          <div className="advisor-diff-cell">
            <span className="stat-label">Verdict</span>
            <span className={after.className}>{after.label}</span>
          </div>
          <div className="advisor-diff-cell">
            <span className="stat-label">Target</span>
            <span className="money strong">{fmtMoney(reply.delta.targetAfter)}</span>
          </div>
        </div>
      </div>
      <p className="advisor-comparison strong">{reply.comparison}</p>
      <p className="advisor-note">{reply.note}</p>
      {isUsSpace ? (
        <p className="muted source-note">
          Household what-if: the goal and prompt apply here, and the plan preview uses the revised
          household numbers. Per-person profile edits belong in the You and Partner spaces.
        </p>
      ) : null}
      {resolved === null ? (
        <div className="advisor-actions">
          <button type="button" className="btn btn-primary btn-small" onClick={onApply}>
            Apply to the plan
          </button>
          <button type="button" className="btn btn-secondary btn-small" onClick={onKeep}>
            Keep as reference
          </button>
        </div>
      ) : (
        <span className={`pill ${resolved === 'applied' ? 'pill-pass' : 'pill-neutral'}`}>
          {resolved === 'applied' ? 'Applied to the plan' : 'Kept as reference'}
        </span>
      )}
    </div>
  );
}
