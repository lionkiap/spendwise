'use client';

/**
 * Wallet gallery: a swipeable showcase of the cards in your wallet.
 *
 * Drag the deck, tap the arrows or use the keyboard to move between cards.
 * Each face is pure CSS in the print palette (solid color, serif monogram, a
 * chip, no images) with a pointer-following 3D tilt. The benefits panel under
 * the deck aggregates this month's ledger with plain deterministic sums: best
 * categories, minimum spend progress and cap headroom.
 */
import { useMemo, useRef, useState } from 'react';

import type { CardSpec, ExpenseCategory } from '../../lib/cards/types';
import {
  CATEGORIES,
  fmtMoney,
  fmtPct,
  isCustomCard,
  type LedgerRow,
} from './shared';

interface CardGalleryProps {
  cards: CardSpec[];
  ledger: LedgerRow[];
  monthKey: string;
  milesValuationCents: number;
}

/** Print-palette face colors, cycled by position in the deck. */
const FACE_COLORS: ReadonlyArray<string> = [
  '#1e4d36',
  '#22261f',
  '#a03d26',
  '#8a6114',
  '#3c5148',
  '#5c3a24',
];

const SWIPE_THRESHOLD_PX = 70;

function categoryLabel(category: ExpenseCategory): string {
  return CATEGORIES.find((entry) => entry.value === category)?.label ?? category;
}

/** This month's deterministic per-card totals from the ledger. */
function monthSummary(card: CardSpec, ledger: LedgerRow[], monthKey: string) {
  const entries = ledger.filter(
    (entry) => entry.monthKey === monthKey && entry.cardId === card.id
  );
  const spentTotal = entries.reduce((sum, entry) => sum + entry.amountSgd, 0);
  const spentByCategory = new Map<ExpenseCategory, number>();
  for (const entry of entries) {
    spentByCategory.set(entry.category, (spentByCategory.get(entry.category) ?? 0) + entry.amountSgd);
  }
  const tiers = [...card.earnStructure]
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 3)
    .map((tier) => {
      const spent = spentByCategory.get(tier.category) ?? 0;
      const capRemaining =
        tier.capMonthlySgd !== undefined ? Math.max(0, tier.capMonthlySgd - spent) : null;
      return { tier, spent, capRemaining };
    });
  const minSpend =
    card.minMonthlySpendSgd !== undefined
      ? { min: card.minMonthlySpendSgd, spent: spentTotal, met: spentTotal >= card.minMonthlySpendSgd }
      : null;
  return { spentTotal, tiers, minSpend };
}

export function CardGallery({ cards, ledger, monthKey, milesValuationCents }: CardGalleryProps) {
  const [index, setIndex] = useState(0);
  const [dragPx, setDragPx] = useState<number | null>(null);
  const startX = useRef(0);

  const safeIndex = Math.min(Math.max(0, index), Math.max(0, cards.length - 1));
  const active = cards[safeIndex];
  const clampedDrag =
    dragPx === null
      ? 0
      : // Resist over-dragging past the ends.
        (safeIndex === 0 && dragPx > 0) || (safeIndex === cards.length - 1 && dragPx < 0)
        ? dragPx * 0.25
        : dragPx;

  function finishDrag(delta: number): void {
    setDragPx(null);
    if (delta <= -SWIPE_THRESHOLD_PX && safeIndex < cards.length - 1) {
      setIndex(safeIndex + 1);
    } else if (delta >= SWIPE_THRESHOLD_PX && safeIndex > 0) {
      setIndex(safeIndex - 1);
    }
  }

  if (cards.length === 0 || active === undefined) {
    return null;
  }

  return (
    <section className="card">
      <div className="card-title-row">
        <h2 className="card-title">Wallet gallery</h2>
        <span className="muted gallery-hint">drag the deck, tap a card for its terms, or use the arrows</span>
      </div>

      <div
        className="gallery-viewport"
        role="group"
        aria-roledescription="carousel"
        aria-label="Your wallet cards"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && safeIndex < cards.length - 1) {
            setIndex(safeIndex + 1);
          }
          if (event.key === 'ArrowLeft' && safeIndex > 0) {
            setIndex(safeIndex - 1);
          }
        }}
        onPointerDown={(event) => {
          startX.current = event.clientX;
          setDragPx(0);
        }}
        onPointerMove={(event) => {
          if (dragPx !== null) {
            setDragPx(event.clientX - startX.current);
          }
        }}
        onPointerUp={(event) => finishDrag(event.clientX - startX.current)}
        onPointerCancel={() => setDragPx(null)}
        onPointerLeave={() => dragPx !== null && finishDrag(0)}
      >
        <div
          className={`gallery-track ${dragPx === null ? 'gallery-track-settled' : ''}`}
          style={{ transform: `translateX(calc(${-safeIndex * 84}% + ${clampedDrag}px))` }}
        >
          {cards.map((card, position) => (
            <div className="gallery-slide" key={card.id}>
              <CardFace
                card={card}
                color={FACE_COLORS[position % FACE_COLORS.length] ?? '#1e4d36'}
                active={position === safeIndex}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="gallery-nav">
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={safeIndex === 0}
          aria-label="Previous card"
          onClick={() => setIndex(safeIndex - 1)}
        >
          &larr;
        </button>
        <div className="gallery-dots" aria-hidden="true">
          {cards.map((card, position) => (
            <button
              key={card.id}
              type="button"
              className={`gallery-dot ${position === safeIndex ? 'gallery-dot-on' : ''}`}
              aria-label={`Show ${card.name}`}
              onClick={() => setIndex(position)}
            />
          ))}
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={safeIndex === cards.length - 1}
          aria-label="Next card"
          onClick={() => setIndex(safeIndex + 1)}
        >
          &rarr;
        </button>
      </div>

      <BenefitsPanel
        key={active.id}
        card={active}
        ledger={ledger}
        monthKey={monthKey}
        milesValuationCents={milesValuationCents}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Card face                                                           */
/* ------------------------------------------------------------------ */

function CardFace({
  card,
  color,
  active,
}: {
  card: CardSpec;
  color: string;
  active: boolean;
}) {
  const [tilt, setTilt] = useState<{ rx: number; ry: number } | null>(null);
  const [flipped, setFlipped] = useState(false);
  const downX = useRef<number | null>(null);

  const headline =
    card.rewardType === 'miles' && card.milesPerDollar !== undefined
      ? `${card.milesPerDollar} mpd`
      : `${fmtPct(card.baseRate, 1)} base`;

  function toggleFlip(): void {
    setFlipped((previous) => !previous);
  }

  function handleClick(event: React.MouseEvent<HTMLDivElement>): void {
    // A release more than a few pixels from the press was a drag, not a tap.
    if (downX.current !== null && Math.abs(event.clientX - downX.current) > 8) {
      return;
    }
    toggleFlip();
  }

  return (
    <div
      className={`gal-card ${active ? 'gal-card-active' : ''}`}
      style={{
        transform:
          tilt === null
            ? undefined
            : `perspective(1000px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
      }}
      onPointerMove={(event) => {
        if (!active) {
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width - 0.5;
        const y = (event.clientY - rect.top) / rect.height - 0.5;
        setTilt({ rx: -y * 10, ry: x * 12 });
      }}
      onPointerLeave={() => setTilt(null)}
    >
      <div
        className={`gal-flip-inner ${flipped ? 'gal-flipped' : ''}`}
        role={active ? 'button' : undefined}
        tabIndex={active ? 0 : undefined}
        aria-label={active ? `Flip ${card.name} to read its full terms` : undefined}
        aria-pressed={active ? flipped : undefined}
        onClick={active ? handleClick : undefined}
        onPointerDown={active ? (event) => { downX.current = event.clientX; } : undefined}
        onKeyDown={
          active
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggleFlip();
                }
              }
            : undefined
        }
      >
        <div className="gal-face gal-front" style={{ background: color }}>
          <span className="gal-monogram" aria-hidden="true">
            {card.name.trim().charAt(0).toUpperCase() || 'S'}
          </span>
          <div className="gal-face-top">
            <span className="gal-issuer">{card.issuer}</span>
            <span className="gal-chip" aria-hidden="true" />
          </div>
          <div className="gal-face-bottom">
            <h3 className="gal-name">{card.name}</h3>
            <div className="gal-face-meta">
              <span className="gal-reward-tag">
                {card.rewardType === 'miles' ? 'MILES' : 'CASHBACK'} · {headline}
              </span>
              <span className="gal-fee">{fmtMoney(card.annualFeeSgd)}/yr</span>
            </div>
          </div>
          {active ? <span className="gal-tap-hint">tap to flip</span> : null}
        </div>

        <div className="gal-face gal-back" style={{ background: color }}>
          <div className="gal-magstripe" aria-hidden="true" />
          <div className="gal-back-body">
            <span className="gal-back-title">Card terms</span>
            <dl className="gal-back-rows">
              <div>
                <dt>Base</dt>
                <dd>
                  {card.rewardType === 'miles'
                    ? `${card.baseRate} mpd everywhere`
                    : `${fmtPct(card.baseRate, 2)} everywhere`}
                </dd>
              </div>
              {card.earnStructure.map((tier) => (
                <div key={tier.category}>
                  <dt>{categoryLabel(tier.category)}</dt>
                  <dd>
                    {card.rewardType === 'miles' ? `${tier.rate} mpd` : fmtPct(tier.rate, 1)}
                    {tier.capMonthlySgd !== undefined ? ` · cap ${fmtMoney(tier.capMonthlySgd)}/mo` : ''}
                  </dd>
                </div>
              ))}
              {card.minMonthlySpendSgd !== undefined ? (
                <div>
                  <dt>Min spend</dt>
                  <dd>
                    {fmtMoney(card.minMonthlySpendSgd)}/mo
                    {card.minSpendNote !== undefined ? ' to unlock bonuses' : ''}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Annual fee</dt>
                <dd>{fmtMoney(card.annualFeeSgd)}</dd>
              </div>
            </dl>
            <p className="gal-back-source">{card.sourceNote}</p>
            {active ? <span className="gal-tap-hint gal-tap-hint-back">tap to flip back</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Benefits panel                                                      */
/* ------------------------------------------------------------------ */

function BenefitsPanel({
  card,
  ledger,
  monthKey,
  milesValuationCents,
}: {
  card: CardSpec;
  ledger: LedgerRow[];
  monthKey: string;
  milesValuationCents: number;
}) {
  const summary = useMemo(() => monthSummary(card, ledger, monthKey), [card, ledger, monthKey]);

  return (
    <div className="gal-benefits">
      <div className="gal-benefits-head">
        <div>
          <h3 className="gal-benefits-name">{card.name}</h3>
          <p className="muted">
            {card.issuer}
            {isCustomCard(card) ? ' · your card' : ''} · base{' '}
            {card.rewardType === 'miles'
              ? `${card.baseRate} mpd`
              : fmtPct(card.baseRate, 2)}
            {card.rewardType === 'miles' ? ` · miles valued at ${milesValuationCents.toFixed(1)}¢` : ''}
          </p>
        </div>
        <span className="pill pill-neutral">{fmtMoney(card.annualFeeSgd)} annual fee</span>
      </div>

      <h4 className="section-subtitle">Best for</h4>
      <div className="chip-row">
        {summary.tiers.map(({ tier }) => (
          <span className="pill pill-info" key={tier.category}>
            {categoryLabel(tier.category)}{' '}
            {card.rewardType === 'miles' ? `${tier.rate} mpd` : fmtPct(tier.rate, 1)}
            {tier.capMonthlySgd !== undefined ? ` · cap ${fmtMoney(tier.capMonthlySgd)}` : ''}
          </span>
        ))}
        {summary.tiers.length === 0 ? (
          <span className="pill pill-neutral">Every purchase earns the base rate</span>
        ) : null}
      </div>

      <h4 className="section-subtitle">This month</h4>
      <div className="progress-stack">
        <p className="muted gal-logged">
          {summary.spentTotal > 0
            ? `${fmtMoney(summary.spentTotal)} logged on this card so far.`
            : 'Nothing logged on this card this month yet.'}
        </p>
        {summary.minSpend !== null ? (
          <div className="progress-row">
            <div className="progress-label">
              <span>
                Minimum spend{' '}
                {summary.minSpend.met ? (
                  <span className="gal-met">met</span>
                ) : (
                  <span className="gal-unmet">{fmtMoney(Math.max(0, summary.minSpend.min - summary.minSpend.spent))} to go</span>
                )}
              </span>
              <span className="progress-value">
                {fmtMoney(summary.minSpend.spent)} / {fmtMoney(summary.minSpend.min)}
              </span>
            </div>
            <div className="progress">
              <div
                className={`progress-fill ${summary.minSpend.met ? 'progress-done' : ''}`}
                style={{ width: `${Math.min(100, (summary.minSpend.spent / summary.minSpend.min) * 100)}%` }}
              />
            </div>
          </div>
        ) : null}
        {summary.tiers.map(({ tier, spent, capRemaining }) =>
          tier.capMonthlySgd !== undefined ? (
            <div className="progress-row" key={tier.category}>
              <div className="progress-label">
                <span>
                  {categoryLabel(tier.category)} cap ·{' '}
                  {capRemaining !== null && capRemaining > 0
                    ? `${fmtMoney(capRemaining)} headroom`
                    : 'exhausted'}
                </span>
                <span className="progress-value">
                  {fmtMoney(spent)} / {fmtMoney(tier.capMonthlySgd)}
                </span>
              </div>
              <div className="progress">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.min(100, (spent / tier.capMonthlySgd) * 100)}%` }}
                />
              </div>
            </div>
          ) : null
        )}
      </div>

      <p className="muted source-note">{card.sourceNote}</p>
    </div>
  );
}
