import { describe, expect, it } from "vitest";
import { routeExpense, walletAudit } from "../lib/cards/engine";
import type { CardSpec, MonthlyLedger } from "../lib/cards/types";
import { CARDS } from "../lib/data/cards";

const MONTH = "2025-03";

const conditionalBonus: CardSpec = {
  id: "bonus-conditional",
  issuer: "Test Bank",
  name: "Conditional High Bonus",
  rewardType: "cashback",
  earnStructure: [
    { category: "dining", rate: 0.1, capMonthlySgd: 200, note: "10% dining up to S$200 spend" },
  ],
  baseRate: 0.01,
  minMonthlySpendSgd: 500,
  minSpendNote: "S$500 monthly spend required for bonus rates",
  annualFeeSgd: 0,
  sourceNote: "Illustrative test terms as of 2025.",
};

const flatCard: CardSpec = {
  id: "flat",
  issuer: "Test Bank",
  name: "Flat Rate",
  rewardType: "cashback",
  earnStructure: [],
  baseRate: 0.03,
  annualFeeSgd: 0,
  sourceNote: "Illustrative test terms as of 2025.",
};

const cappedRich: CardSpec = {
  id: "capped-rich",
  issuer: "Test Bank",
  name: "Capped Rich Tier",
  rewardType: "cashback",
  earnStructure: [
    { category: "dining", rate: 0.2, capMonthlySgd: 100, note: "20% dining up to S$100 spend" },
  ],
  baseRate: 0.01,
  annualFeeSgd: 0,
  sourceNote: "Illustrative test terms as of 2025.",
};

const uncappedSteady: CardSpec = {
  id: "uncapped-steady",
  issuer: "Test Bank",
  name: "Uncapped Steady",
  rewardType: "cashback",
  earnStructure: [{ category: "dining", rate: 0.05, note: "5% dining, uncapped" }],
  baseRate: 0.005,
  annualFeeSgd: 0,
  sourceNote: "Illustrative test terms as of 2025.",
};

const milesCard: CardSpec = {
  id: "miles-high",
  issuer: "Test Bank",
  name: "High Miles",
  rewardType: "miles",
  earnStructure: [{ category: "dining", rate: 4, note: "4 mpd dining" }],
  baseRate: 1,
  milesPerDollar: 4,
  annualFeeSgd: 0,
  sourceNote: "Illustrative test terms as of 2025.",
};

const cashbackRival: CardSpec = {
  id: "cashback-rival",
  issuer: "Test Bank",
  name: "Rival Cashback",
  rewardType: "cashback",
  earnStructure: [{ category: "dining", rate: 0.05, note: "5% dining" }],
  baseRate: 0.005,
  annualFeeSgd: 0,
  sourceNote: "Illustrative test terms as of 2025.",
};

const diningPurchase = { amountSgd: 100, category: "dining" as const };

describe("routeExpense: minimum spend conditions", () => {
  it("flags the reward conditional and keeps base rate when the minimum spend is unmet", () => {
    const ledger: MonthlyLedger = { monthKey: MONTH, entries: [] };
    const recs = routeExpense([conditionalBonus, flatCard], diningPurchase, ledger);

    const bonus = recs.find((rec) => rec.cardId === "bonus-conditional");
    expect(bonus).toBeDefined();
    expect(bonus?.conditional).toBe(true);
    expect(bonus?.rewardValueSgd).toBeCloseTo(1.0, 2); // base 1% only
    expect(bonus?.mathTrace.join(" ")).toContain("unlock");

    // flat 3% beats a conditional 10% card
    expect(recs[0]?.cardId).toBe("flat");
  });

  it("flips the winner to the bonus card once the minimum spend is met", () => {
    const ledger: MonthlyLedger = {
      monthKey: MONTH,
      entries: [
        {
          cardId: "bonus-conditional",
          amountSgd: 450,
          category: "groceries",
          monthKey: MONTH,
        },
      ],
    };
    const recs = routeExpense([conditionalBonus, flatCard], diningPurchase, ledger);

    const bonus = recs.find((rec) => rec.cardId === "bonus-conditional");
    expect(bonus?.conditional).toBe(false);
    expect(bonus?.rewardValueSgd).toBeCloseTo(10.0, 2); // 10% of 100, inside the S$200 cap
    expect(recs[0]?.cardId).toBe("bonus-conditional");
  });

  it("reports the tier cap remaining before the purchase, reduced by logged spend", () => {
    const ledger: MonthlyLedger = {
      monthKey: MONTH,
      entries: [
        {
          cardId: "bonus-conditional",
          amountSgd: 100,
          category: "dining",
          monthKey: MONTH,
        },
      ],
    };
    const recs = routeExpense([conditionalBonus], diningPurchase, ledger);
    expect(recs[0]?.capRemainingSgd).toBe(100); // S$200 cap minus S$100 already logged
  });
});

describe("routeExpense: monthly caps", () => {
  it("routes to the second best card once the category cap is exhausted", () => {
    const ledger: MonthlyLedger = {
      monthKey: MONTH,
      entries: [
        { cardId: "capped-rich", amountSgd: 100, category: "dining", monthKey: MONTH },
      ],
    };
    const recs = routeExpense([cappedRich, uncappedSteady], diningPurchase, ledger);

    expect(recs[0]?.cardId).toBe("uncapped-steady");
    expect(recs[0]?.rewardValueSgd).toBeCloseTo(5.0, 2); // 5% of 100, uncapped

    const capped = recs.find((rec) => rec.cardId === "capped-rich");
    expect(capped?.capRemainingSgd).toBe(0);
    expect(capped?.rewardValueSgd).toBeCloseTo(1.0, 2); // overflow 100 earns base 1%
    expect(capped?.mathTrace.join(" ")).toContain("overflow");
  });

  it("reports Infinity as cap remaining for uncapped tiers", () => {
    const recs = routeExpense(
      [uncappedSteady],
      diningPurchase,
      { monthKey: MONTH, entries: [] },
    );
    expect(recs[0]?.capRemainingSgd).toBe(Infinity);
  });
});

describe("routeExpense: miles valuation", () => {
  it("keeps cashback winning at a low miles valuation", () => {
    const recs = routeExpense(
      [milesCard, cashbackRival],
      diningPurchase,
      { monthKey: MONTH, entries: [] },
      { milesValuationCents: 1.0 },
    );
    expect(recs[0]?.cardId).toBe("cashback-rival"); // S$5.00 vs 400 miles x 1.0c = S$4.00
    expect(recs[0]?.rewardValueSgd).toBeCloseTo(5.0, 2);
  });

  it("flips to the miles card when the valuation rises", () => {
    const recs = routeExpense(
      [milesCard, cashbackRival],
      diningPurchase,
      { monthKey: MONTH, entries: [] },
      { milesValuationCents: 2.0 },
    );
    expect(recs[0]?.cardId).toBe("miles-high"); // 400 miles x 2.0c = S$8.00 beats S$5.00
    expect(recs[0]?.rewardValueSgd).toBeCloseTo(8.0, 2);
  });

  it("converts miles at the default 1.8 cents per mile when no option is given", () => {
    const recs = routeExpense(
      [milesCard],
      diningPurchase,
      { monthKey: MONTH, entries: [] },
    );
    expect(recs[0]?.rewardValueSgd).toBeCloseTo(7.2, 2); // 400 miles x 1.8c
    expect(recs[0]?.effectiveRatePct).toBeCloseTo(7.2, 2);
    expect(recs[0]?.mathTrace.join(" ")).toContain("1.80 cents/mile");
  });
});

describe("walletAudit", () => {
  const bestDining: CardSpec = {
    id: "best-dining",
    issuer: "Test Bank",
    name: "Best Dining",
    rewardType: "cashback",
    earnStructure: [{ category: "dining", rate: 0.1, note: "10% dining, uncapped" }],
    baseRate: 0.01,
    annualFeeSgd: 0,
    sourceNote: "Illustrative test terms as of 2025.",
  };
  const weakDining: CardSpec = {
    id: "weak-dining",
    issuer: "Test Bank",
    name: "Weak Dining",
    rewardType: "cashback",
    earnStructure: [{ category: "dining", rate: 0.01, note: "1% dining" }],
    baseRate: 0.01,
    annualFeeSgd: 0,
    sourceNote: "Illustrative test terms as of 2025.",
  };

  it("reports leftOnTableSgd greater than zero for a suboptimal log", () => {
    const ledger: MonthlyLedger = {
      monthKey: MONTH,
      entries: [
        { cardId: "weak-dining", amountSgd: 100, category: "dining", monthKey: MONTH },
        { cardId: "weak-dining", amountSgd: 50, category: "dining", monthKey: MONTH },
        { cardId: "best-dining", amountSgd: 50, category: "dining", monthKey: MONTH },
      ],
    };
    const audit = walletAudit([bestDining, weakDining], ledger);

    expect(audit.actualValueSgd).toBeCloseTo(6.5, 2); // 100x1% + 50x1% + 50x10%
    expect(audit.optimalValueSgd).toBeCloseTo(20.0, 2); // 200 x 10%
    expect(audit.leftOnTableSgd).toBeGreaterThan(0);
    expect(audit.leftOnTableSgd).toBeCloseTo(13.5, 2);
    expect(audit.misses).toHaveLength(2);
    expect(audit.misses[0]).toMatchObject({
      index: 0,
      usedCardId: "weak-dining",
      bestCardId: "best-dining",
      lostSgd: 9.0,
    });
    expect(audit.misses[0]?.why).toContain("best-dining");
  });

  it("reports zero left on the table for an already optimal log", () => {
    const ledger: MonthlyLedger = {
      monthKey: MONTH,
      entries: [
        { cardId: "best-dining", amountSgd: 100, category: "dining", monthKey: MONTH },
      ],
    };
    const audit = walletAudit([bestDining, weakDining], ledger);
    expect(audit.leftOnTableSgd).toBe(0);
    expect(audit.misses).toHaveLength(0);
  });
});

describe("CARDS dataset smoke test", () => {
  it("ships 14 cards, each with a nonempty sourceNote disclaimer", () => {
    expect(CARDS).toHaveLength(14);

    const ids = new Set(CARDS.map((card) => card.id));
    expect(ids.size).toBe(14);

    for (const card of CARDS) {
      expect(card.sourceNote.length).toBeGreaterThan(0);
      expect(card.sourceNote).toContain("2025");
      expect(card.baseRate).toBeGreaterThan(0);
      expect(["cashback", "miles"]).toContain(card.rewardType);
      if (card.rewardType === "miles") {
        expect(card.milesPerDollar).toBeGreaterThan(0);
      }
      if (card.minMonthlySpendSgd != null) {
        expect(card.minSpendNote).toBeTruthy();
      }
    }
  });

  it("ranks recommendations best first over the real dataset", () => {
    const recs = routeExpense(
      CARDS,
      { amountSgd: 300, category: "groceries" },
      { monthKey: MONTH, entries: [] },
    );
    expect(recs).toHaveLength(CARDS.length);
    for (let i = 1; i < recs.length; i++) {
      expect(recs[i - 1]?.rewardValueSgd ?? 0).toBeGreaterThanOrEqual(
        recs[i]?.rewardValueSgd ?? 0,
      );
    }
  });
});
