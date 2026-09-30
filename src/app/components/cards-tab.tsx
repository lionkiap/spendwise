'use client';

/**
 * Card Maximizer tab.
 *
 * Everything here runs in the browser with zero model calls: the wallet
 * picker, custom card manager, expense router and monthly audit all operate
 * on the merged deck mergeCards(CARDS, customCards) handed in by the page.
 * The one network touch is optional: the Explain misses button posts the
 * deterministic misses to /api/audit/explain and renders the reply, degrading
 * to the deterministic why text whenever the server answers deterministic.
 */
import { useEffect, useMemo, useState } from 'react';

import { routeExpense, walletAudit, type Recommendation } from '../../lib/cards/engine';
import type { CardSpec, ExpenseCategory } from '../../lib/cards/types';
import {
  CATEGORIES,
  MILES_VALUATION_MAX,
  MILES_VALUATION_MIN,
  fmtMoney,
  fmtPct,
  isCustomCard,
  type CustomCardStored,
  type LedgerRow,
} from './shared';
import { CustomCardManager } from './custom-card-manager';
import { LedgerManager } from './ledger-manager';
import { CardGallery } from './card-gallery';

interface CardsTabProps {
  wallet: string[];
  onToggleWallet: (id: string) => void;
  allCards: CardSpec[];
  customStored: CustomCardStored[];
  onSaveCustom: (draft: CustomCardStored, editingIndex: number | null) => void;
  onDeleteCustom: (index: number) => void;
  ledger: LedgerRow[];
  monthKey: string;
  milesValuation: number;
  onMilesValuationChange: (value: number) => void;
  onDeleteLedgerEntry: (ledgerIndex: number) => void;
  onClearMonth: () => void;
  onLoadSampleMonth: () => void;
  onAppendEntry: (entry: LedgerRow) => void;
}

interface ExpenseFormState {
  amount: string;
  category: ExpenseCategory;
  merchant: string;
}

interface ExplainState {
  loading: boolean;
  engine: 'ultra' | 'deterministic' | null;
  explanations: string[] | null;
  error: string | null;
}

const EXPLAIN_IDLE: ExplainState = {
  loading: false,
  engine: null,
  explanations: null,
  error: null,
};

export function CardsTab({
  wallet,
  onToggleWallet,
  allCards,
  customStored,
  onSaveCustom,
  onDeleteCustom,
  ledger,
  monthKey,
  milesValuation,
  onMilesValuationChange,
  onDeleteLedgerEntry,
  onClearMonth,
  onLoadSampleMonth,
  onAppendEntry,
}: CardsTabProps) {
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
  const [explain, setExplain] = useState<ExplainState>(EXPLAIN_IDLE);

  const cardById = useMemo(() => new Map<string, CardSpec>(allCards.map((card) => [card.id, card])), [allCards]);
  const walletCards = useMemo(() => allCards.filter((card) => wallet.includes(card.id)), [allCards, wallet]);

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

  // A new audit invalidates any previous explanations.
  useEffect(() => {
    setExplain(EXPLAIN_IDLE);
  }, [audit]);

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
    const entry: LedgerRow = {
      cardId: recommendation.cardId,
      amountSgd: lastSpend.amountSgd,
      category: lastSpend.category,
      monthKey,
      ...(lastSpend.merchantText !== undefined ? { merchant: lastSpend.merchantText } : {}),
    };
    onAppendEntry(entry);
  }

  async function handleExplain(): Promise<void> {
    if (audit === null || audit.misses.length === 0) {
      return;
    }
    setExplain({ loading: true, engine: null, explanations: null, error: null });
    const cardNames: Record<string, string> = {};
    for (const card of walletCards) {
      cardNames[card.id] = card.name;
    }
    try {
      const response = await fetch('/api/audit/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ misses: audit.misses, monthKey, cardNames }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const message =
          data !== null && typeof data === 'object' && 'error' in data
            ? String((data as { error: unknown }).error)
            : `Explain request failed with status ${response.status}.`;
        setExplain({ loading: false, engine: null, explanations: null, error: message });
        return;
      }
      if (
        data !== null &&
        typeof data === 'object' &&
        (data as Record<string, unknown>).engine === 'deterministic'
      ) {
        setExplain({ loading: false, engine: 'deterministic', explanations: null, error: null });
        return;
      }
      if (data !== null && typeof data === 'object') {
        const payload = data as { engine?: unknown; explanations?: unknown };
        if (
          payload.engine === 'ultra' &&
          Array.isArray(payload.explanations) &&
          payload.explanations.length === audit.misses.length &&
          payload.explanations.every((line) => typeof line === 'string')
        ) {
          setExplain({
            loading: false,
            engine: 'ultra',
            explanations: payload.explanations as string[],
            error: null,
          });
          return;
        }
      }
      setExplain({
        loading: false,
        engine: null,
        explanations: null,
        error: 'The explain reply was not usable; the deterministic explanations stand.',
      });
    } catch {
      setExplain({
        loading: false,
        engine: null,
        explanations: null,
        error: 'Could not reach the explain API. The deterministic explanations stand.',
      });
    }
  }

  return (
    <div className="stack">
      {walletCards.length > 0 ? (
        <CardGallery
          cards={walletCards}
          ledger={ledger}
          monthKey={monthKey}
          milesValuationCents={milesValuation}
        />
      ) : null}
      <div className="duo">
        <section className="card">
          <h2 className="card-title">Your wallet</h2>
          <div className="wallet-list">
            {allCards.map((card) => {
              const checked = wallet.includes(card.id);
              return (
                <label key={card.id} className={`wallet-item ${checked ? 'wallet-item-on' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => onToggleWallet(card.id)} />
                  <span className="wallet-item-body">
                    <span className="wallet-item-name">
                      {card.name}
                      {isCustomCard(card) ? <span className="custom-badge">Custom</span> : null}
                    </span>
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

        <div className="duo-side">
          <section className="card">
            <h2 className="card-title">Route an expense</h2>
            <div className="field-row field-row-stack">
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
                <span className="muted form-hint">Select at least one card first.</span>
              ) : null}
            </div>
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
                onChange={(event) => onMilesValuationChange(Number(event.target.value))}
              />
              <span className="slider-value">{milesValuation.toFixed(2)} cents per mile</span>
            </div>
          </section>
        </div>
      </div>

      {recommendations !== null && lastSpend !== null ? (
        <section className="card">
          <h2 className="card-title">
            Ranked picks for {fmtMoney(lastSpend.amountSgd)} on {lastSpend.category.replace('_', ' ')}
          </h2>
          <ol className="rec-list">
            {recommendations.map((recommendation, index) => {
              const card = cardById.get(recommendation.cardId);
              return (
                <li key={recommendation.cardId} className={`rec ${index === 0 ? 'rec-best' : ''}`}>
                  <div className="rec-head">
                    <span className="rec-rank">#{index + 1}</span>
                    <span className="rec-name">
                      {card?.name ?? recommendation.cardId}
                      {card !== undefined && isCustomCard(card) ? (
                        <span className="custom-badge">Custom</span>
                      ) : null}
                    </span>
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

      <CustomCardManager stored={customStored} onSave={onSaveCustom} onDelete={onDeleteCustom} />

      <LedgerManager
        ledger={ledger}
        monthKey={monthKey}
        cardById={cardById}
        onDeleteEntry={onDeleteLedgerEntry}
        onClearMonth={onClearMonth}
        onLoadSampleMonth={onLoadSampleMonth}
      />

      <section className="card">
        <h2 className="card-title">Month progress</h2>

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
              <div key={`${row.card.id}-${row.category}`} className="progress-row">
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
      </section>

      <section className="card">
        <h2 className="card-title">Left on the table</h2>
        {audit === null ? (
          <p className="muted">Log at least one purchase this month to run the audit.</p>
        ) : (
          <div className="audit">
            <p className="money">
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
              <>
                <ul className="audit-misses">
                  {audit.misses.map((miss, missIndex) => {
                    const line =
                      explain.engine === 'ultra' && explain.explanations !== null
                        ? explain.explanations[missIndex]
                        : undefined;
                    return (
                      <li key={miss.index}>
                        <span className="pill pill-fail">{fmtMoney(miss.lostSgd)} lost</span>{' '}
                        {miss.why}
                        {line !== undefined ? (
                          <p className="miss-explanation">
                            <span className="engine-badge engine-badge-ultra">Nemotron Ultra</span>{' '}
                            {line}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <div className="explain-row">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleExplain}
                    disabled={explain.loading}
                  >
                    {explain.loading ? 'Explaining...' : 'Explain misses with Nemotron'}
                  </button>
                  {explain.engine === 'deterministic' ? (
                    <span className="muted local-mode-note">
                      Local mode: no Nemotron key configured, so the deterministic explanations
                      above stand.
                    </span>
                  ) : null}
                  {explain.error !== null ? (
                    <span className="error-text" role="alert">
                      {explain.error}
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
