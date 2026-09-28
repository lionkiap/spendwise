import type {
  CardSpec,
  ExpenseCategory,
  LedgerEntry,
  MonthlyLedger,
  SpendInput,
} from "./types";

/** Default miles valuation: 1.8 SGD cents per mile. */
export const DEFAULT_MILES_VALUATION_CENTS = 1.8;

export interface RouteOptions {
  /** SGD cents per mile for miles cards. Default 1.8. */
  milesValuationCents?: number;
  /**
   * Which calendar month ("YYYY-MM") to read caps and minimum spends from.
   * Defaults to the lexicographically latest monthKey present in the ledger,
   * or to a month with no history when the ledger is empty. Deterministic:
   * no wall-clock reads anywhere in the engine.
   */
  monthKey?: string;
}

export interface Recommendation {
  cardId: string;
  /** Reward expressed in SGD (cashback directly, miles x valuation). */
  rewardValueSgd: number;
  /** rewardValueSgd as a percentage of the purchase amount. */
  effectiveRatePct: number;
  /** True when the card's monthly minimum spend is not yet met, so bonus rates are withheld and only baseRate is paid. */
  conditional: boolean;
  /** Human-readable lines showing the arithmetic. */
  mathTrace: string[];
  /** Tier cap headroom in SGD before this purchase. Infinity when the applied rate is uncapped. */
  capRemainingSgd: number;
}

export interface AuditMiss {
  /** Zero-based index of the ledger entry in replay order. */
  index: number;
  usedCardId: string;
  bestCardId: string;
  lostSgd: number;
  why: string;
}

export interface WalletAuditResult {
  monthKey: string;
  actualValueSgd: number;
  optimalValueSgd: number;
  leftOnTableSgd: number;
  misses: AuditMiss[];
}

interface CardEvaluation {
  rewardValueSgd: number;
  conditional: boolean;
  capRemainingSgd: number;
  /** True when the applied rate is the card's base rate instead of a bonus tier. */
  usedBaseRate: boolean;
  mathTrace: string[];
}

const money = (n: number): string => `S$${n.toFixed(2)}`;
const pct = (rate: number): string => `${(rate * 100).toFixed(2)}%`;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const sameMonth = (entry: LedgerEntry, cardId: string, monthKey: string): boolean =>
  entry.cardId === cardId && entry.monthKey === monthKey;

function latestMonthKey(ledger: MonthlyLedger): string {
  let latest = "";
  for (const entry of ledger.entries) {
    if (entry.monthKey > latest) latest = entry.monthKey;
  }
  return latest;
}

function spendInMonth(history: LedgerEntry[], cardId: string, monthKey: string): number {
  return history
    .filter((entry) => sameMonth(entry, cardId, monthKey))
    .reduce((sum, entry) => sum + entry.amountSgd, 0);
}

function tierSpendInMonth(
  history: LedgerEntry[],
  cardId: string,
  category: ExpenseCategory,
  monthKey: string,
): number {
  return history
    .filter(
      (entry) =>
        sameMonth(entry, cardId, monthKey) && entry.category === category,
    )
    .reduce((sum, entry) => sum + entry.amountSgd, 0);
}

/**
 * Score one purchase against one card, given the purchase history already
 * logged for the month. Pure: no mutation, no clock, no randomness.
 *
 * Engine rules:
 *  - The matching bonus tier's rate applies when the card has a tier for the
 *    category; otherwise the card's uncapped baseRate applies.
 *  - A tier's monthly cap (in SGD of spend) is reduced by the spend already
 *    logged for that card and category this month; spend above the remaining
 *    headroom earns the baseRate.
 *  - When the card has a monthly minimum spend that is not met even with this
 *    purchase included, bonus tiers are withheld, the whole purchase earns
 *    baseRate, and the evaluation is flagged conditional.
 *  - Miles cards convert earned miles at milesValuationCents.
 */
function evaluateCard(
  card: CardSpec,
  spend: SpendInput,
  history: LedgerEntry[],
  monthKey: string,
  milesValuationCents: number,
): CardEvaluation {
  const amount = spend.amountSgd;
  const priorCardSpend = spendInMonth(history, card.id, monthKey);
  const minMonthlySpendSgd = card.minMonthlySpendSgd;
  const conditional =
    minMonthlySpendSgd != null &&
    priorCardSpend + amount < minMonthlySpendSgd;

  const tier = card.earnStructure.find((t) => t.category === spend.category) ?? null;
  const hasCap = tier != null && tier.capMonthlySgd != null;
  const tierRemaining = hasCap
    ? Math.max(
        0,
        (tier?.capMonthlySgd as number) -
          tierSpendInMonth(history, card.id, spend.category, monthKey),
      )
    : Infinity;

  const rate = conditional ? card.baseRate : tier != null ? tier.rate : card.baseRate;
  const cappedSpend = conditional || !hasCap ? amount : Math.min(amount, tierRemaining);
  const overflowSpend = amount - cappedSpend;

  const bonusUnits = cappedSpend * rate;
  const overflowUnits = overflowSpend * card.baseRate;
  const totalUnits = bonusUnits + overflowUnits;
  const rewardValueSgd =
    card.rewardType === "miles"
      ? (totalUnits * milesValuationCents) / 100
      : totalUnits;

  const trace: string[] = [
    `spend: ${money(amount)} on ${spend.category}`,
    `card: ${card.name} (${card.rewardType})`,
  ];

  if (conditional) {
    trace.push(
      `rate: ${pct(card.baseRate)} base only; minimum monthly spend ${money(
        minMonthlySpendSgd,
      )} not met (${money(priorCardSpend + amount)} of ${money(
        minMonthlySpendSgd,
      )})`,
    );
    trace.push(
      `unlock: add ${money(
        minMonthlySpendSgd - priorCardSpend - amount,
      )} more spend on this card this month to earn ${pct(
        tier != null ? tier.rate : card.baseRate,
      )} on ${spend.category}`,
    );
  } else if (tier != null) {
    trace.push(`rate: ${pct(tier.rate)} ${spend.category} tier`);
    if (hasCap) {
      trace.push(
        `cap: ${money(tierRemaining)} of ${money(
          tier.capMonthlySgd as number,
        )} cap remaining before this purchase`,
      );
    } else {
      trace.push(`cap: none for the ${spend.category} tier`);
    }
  } else {
    trace.push(`rate: ${pct(card.baseRate)} base (no ${spend.category} tier)`);
  }

  if (overflowSpend > 0) {
    trace.push(
      `overflow: ${money(overflowSpend)} above the cap earns base ${pct(
        card.baseRate,
      )}`,
    );
  }

  if (card.rewardType === "miles") {
    trace.push(
      `reward: ${totalUnits.toFixed(2)} miles x ${milesValuationCents.toFixed(
        2,
      )} cents/mile = ${money(rewardValueSgd)}`,
    );
  } else {
    trace.push(`reward: ${money(rewardValueSgd)} cashback`);
  }

  return {
    rewardValueSgd,
    conditional,
    capRemainingSgd: tierRemaining,
    usedBaseRate: conditional || tier == null,
    mathTrace: trace,
  };
}

const byBestReward = (
  a: Recommendation,
  b: Recommendation,
): number => b.rewardValueSgd - a.rewardValueSgd || a.cardId.localeCompare(b.cardId);

/**
 * Rank every card for one purchase, best first. Caps and minimum spends are
 * read from the ledger for the resolved month. Pure.
 */
export function routeExpense(
  cards: CardSpec[],
  spend: SpendInput,
  ledger: MonthlyLedger,
  opts: RouteOptions = {},
): Recommendation[] {
  const milesValuationCents =
    opts.milesValuationCents ?? DEFAULT_MILES_VALUATION_CENTS;
  const monthKey = opts.monthKey ?? latestMonthKey(ledger);
  const history = ledger.entries.filter((entry) => entry.monthKey === monthKey);

  const recommendations = cards.map((card) => {
    const evaluation = evaluateCard(
      card,
      spend,
      history,
      monthKey,
      milesValuationCents,
    );
    const effectiveRatePct =
      spend.amountSgd === 0
        ? 0
        : round2((evaluation.rewardValueSgd / spend.amountSgd) * 100);
    return {
      cardId: card.id,
      rewardValueSgd: round2(evaluation.rewardValueSgd),
      effectiveRatePct,
      conditional: evaluation.conditional,
      mathTrace: evaluation.mathTrace,
      capRemainingSgd: evaluation.capRemainingSgd,
    };
  });

  return recommendations.sort(byBestReward);
}

/**
 * Replay a month entry by entry twice: once over the cards the user actually
 * used, and once over an always-optimal chooser whose own cap and minimum
 * spend state evolves with its choices. Reports what the actual wallet earned,
 * what the optimal wallet would have earned, the gap, and per-entry misses.
 */
export function walletAudit(
  cards: CardSpec[],
  ledger: MonthlyLedger,
  opts: RouteOptions = {},
): WalletAuditResult {
  const milesValuationCents =
    opts.milesValuationCents ?? DEFAULT_MILES_VALUATION_CENTS;
  const monthKey = ledger.monthKey;

  let actualTotal = 0;
  let optimalTotal = 0;
  const actualHistory: LedgerEntry[] = [];
  const optimalHistory: LedgerEntry[] = [];
  const misses: AuditMiss[] = [];

  ledger.entries.forEach((entry, index) => {
    const spend: SpendInput = {
      amountSgd: entry.amountSgd,
      category: entry.category,
    };

    const usedCard = cards.find((card) => card.id === entry.cardId);
    const used = usedCard
      ? evaluateCard(usedCard, spend, actualHistory, monthKey, milesValuationCents)
      : {
          rewardValueSgd: 0,
          conditional: false,
          capRemainingSgd: Infinity,
          usedBaseRate: true,
          mathTrace: [`card ${entry.cardId} not in candidate set`],
        };
    actualTotal += used.rewardValueSgd;
    actualHistory.push(entry);

    let bestCardId = "";
    let bestValue = 0;
    let bestEval: CardEvaluation | null = null;
    for (const card of cards) {
      const evaluation = evaluateCard(
        card,
        spend,
        optimalHistory,
        monthKey,
        milesValuationCents,
      );
      if (
        bestEval == null ||
        evaluation.rewardValueSgd - bestEval.rewardValueSgd > 1e-9 ||
        (Math.abs(evaluation.rewardValueSgd - bestEval.rewardValueSgd) <= 1e-9 &&
          card.id.localeCompare(bestCardId) < 0)
      ) {
        bestEval = evaluation;
        bestCardId = card.id;
        bestValue = evaluation.rewardValueSgd;
      }
    }
    if (bestEval == null) {
      // No candidate cards: nothing to compare against.
      return;
    }
    optimalTotal += bestValue;
    optimalHistory.push({
      cardId: bestCardId,
      amountSgd: entry.amountSgd,
      category: entry.category,
      monthKey,
    });

    if (bestCardId !== entry.cardId && bestValue - used.rewardValueSgd > 1e-9) {
      const usedName = usedCard ? usedCard.name : entry.cardId;
      let hint: string;
      if (used.conditional) {
        hint = "used card's bonus rate was locked behind its unmet monthly minimum spend";
      } else if (used.capRemainingSgd === 0) {
        hint = "used card's category cap was already exhausted this month";
      } else if (used.usedBaseRate) {
        hint = "used card paid base rate with no bonus tier for this category";
      } else {
        hint = "used card's rate was lower than the best card's rate";
      }
      misses.push({
        index,
        usedCardId: entry.cardId,
        bestCardId,
        lostSgd: round2(bestValue - used.rewardValueSgd),
        why: `${money(entry.amountSgd)} on ${entry.category}: ${usedName} earned ${money(
          used.rewardValueSgd,
        )} (${hint}); best card ${bestCardId} would have earned ${money(
          bestValue,
        )}`,
      });
    }
  });

  const actualValueSgd = round2(actualTotal);
  const optimalValueSgd = round2(optimalTotal);
  return {
    monthKey,
    actualValueSgd,
    optimalValueSgd,
    leftOnTableSgd: Math.max(0, round2(optimalValueSgd - actualValueSgd)),
    misses,
  };
}
