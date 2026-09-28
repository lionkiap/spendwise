'use client';

/**
 * This-month ledger manager: entries table with per-row delete, Clear month
 * and Load sample month.
 *
 * Deletion addresses rows by their index in the full ledger array (computed
 * once per render), so removing one row never disturbs the others. The sample
 * month is a fixed, realistic list stamped with the current client monthKey,
 * and loading it replaces only this month's entries.
 */
import type { CardSpec } from '../../lib/cards/types';
import { fmtMoney, type LedgerRow } from './shared';

interface LedgerManagerProps {
  ledger: LedgerRow[];
  monthKey: string;
  cardById: Map<string, CardSpec>;
  onDeleteEntry: (ledgerIndex: number) => void;
  onClearMonth: () => void;
  onLoadSampleMonth: () => void;
}

/** Fixed demo purchases: realistic SG merchants, mixed good and lazy routing. */
const SAMPLE_ENTRIES: ReadonlyArray<{
  cardId: string;
  category: LedgerRow['category'];
  amountSgd: number;
  merchant: string;
}> = [
  { cardId: 'uob-one', category: 'groceries', amountSgd: 214.5, merchant: 'FairPrice' },
  { cardId: 'uob-one', category: 'groceries', amountSgd: 86.2, merchant: 'Cold Storage' },
  { cardId: 'dbs-altitude', category: 'dining', amountSgd: 42.8, merchant: 'Maxwell hawker stall' },
  { cardId: 'dbs-live-fresh', category: 'dining', amountSgd: 58.9, merchant: 'McDonald delivery' },
  { cardId: 'sc-unlimited-cashback', category: 'online_shopping', amountSgd: 129.9, merchant: 'Shopee' },
  { cardId: 'hsbc-revolution', category: 'online_shopping', amountSgd: 89.5, merchant: 'Lazada' },
  { cardId: 'uob-one', category: 'transport', amountSgd: 24.6, merchant: 'Grab' },
  { cardId: 'citi-cash-back-plus', category: 'petrol', amountSgd: 95.0, merchant: 'Shell' },
  { cardId: 'krisflyer-uob', category: 'travel', amountSgd: 640.0, merchant: 'Singapore Airlines' },
  { cardId: 'amex-true-cashback', category: 'utilities', amountSgd: 120.3, merchant: 'SP Group' },
  { cardId: 'citi-premiermiles', category: 'entertainment', amountSgd: 19.9, merchant: 'Netflix' },
  { cardId: 'ocbc-titanium-rewards', category: 'medical', amountSgd: 46.0, merchant: 'Guardian pharmacy' },
];

export function buildSampleMonth(monthKey: string): LedgerRow[] {
  return SAMPLE_ENTRIES.map((entry) => ({
    cardId: entry.cardId,
    amountSgd: entry.amountSgd,
    category: entry.category,
    monthKey,
    merchant: entry.merchant,
  }));
}

export function LedgerManager({
  ledger,
  monthKey,
  cardById,
  onDeleteEntry,
  onClearMonth,
  onLoadSampleMonth,
}: LedgerManagerProps) {
  const rows = ledger
    .map((entry, index) => ({ entry, index }))
    .filter((row) => row.entry.monthKey === monthKey);
  const monthTotal = rows.reduce((sum, row) => sum + row.entry.amountSgd, 0);

  return (
    <section className="card">
      <div className="card-title-row ledger-title-row">
        <h2 className="card-title">This month{monthKey ? ` (${monthKey})` : ''}</h2>
        <div className="ledger-actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={onLoadSampleMonth}>
            Load sample month
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-small btn-danger"
            onClick={onClearMonth}
            disabled={rows.length === 0}
          >
            Clear month
          </button>
        </div>
      </div>
      <p className="muted money">
        {rows.length} purchase{rows.length === 1 ? '' : 's'} logged this month,{' '}
        {fmtMoney(monthTotal)} across {new Set(rows.map((row) => row.entry.cardId)).size} card
        {new Set(rows.map((row) => row.entry.cardId)).size === 1 ? '' : 's'}.
      </p>

      {rows.length === 0 ? (
        <p className="muted">
          Nothing logged yet. Log picks from the router above or load a sample month to explore
          the caps, minimum spends and audit.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="table ledger-table">
            <thead>
              <tr>
                <th>Card</th>
                <th>Category</th>
                <th className="num">Amount</th>
                <th>Merchant</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entry, index }) => {
                const cardName = cardById.get(entry.cardId)?.name ?? entry.cardId;
                return (
                  <tr key={index}>
                    <td className="strong">{cardName}</td>
                    <td>{entry.category.replace('_', ' ')}</td>
                    <td className="num">{fmtMoney(entry.amountSgd)}</td>
                    <td className="muted">{entry.merchant ?? '-'}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="btn btn-ghost btn-small btn-danger"
                        aria-label={`Delete ${cardName} ${entry.category.replace('_', ' ')} purchase of ${fmtMoney(entry.amountSgd)}`}
                        onClick={() => onDeleteEntry(index)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
