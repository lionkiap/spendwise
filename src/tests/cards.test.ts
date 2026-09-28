import { describe, expect, it } from "vitest";
import { blankCustomCardDraft, mergeCards, parseCustomCard } from "../lib/cards/custom";
import type { AuditMiss } from "../lib/cards/engine";
import { routeExpense, walletAudit } from "../lib/cards/engine";
import { explainMisses } from "../lib/cards/explain";
import type { CardSpec, MonthlyLedger } from "../lib/cards/types";
import { CARDS } from "../lib/data/cards";
import { ultraModel } from "../lib/nebius";

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

describe("parseCustomCard", () => {
  const validInput = {
    name: "  My Grocery Card ",
    rewardType: "cashback",
    baseRate: 0.01,
    earnStructure: [
      { category: "groceries", rate: 0.2, capMonthlySgd: 600 },
      { category: "dining", rate: 0.05 },
    ],
    minMonthlySpendSgd: 0,
    annualFeeSgd: 0,
  };

  it("accepts a valid input, trims and slugs the name, defaults the issuer and forces the sourceNote", () => {
    const result = parseCustomCard(validInput);
    if (!result.ok) {
      throw new Error(`expected the valid fixture to parse, got ${result.errors.join(" | ")}`);
    }

    expect(result.card.id).toBe("my-grocery-card");
    expect(result.card.name).toBe("My Grocery Card");
    expect(result.card.issuer).toBe("Personal"); // issuer was omitted
    expect(result.card.rewardType).toBe("cashback");
    expect(result.card.baseRate).toBe(0.01);
    expect(result.card.earnStructure).toHaveLength(2);
    expect(result.card.earnStructure[0]).toMatchObject({
      category: "groceries",
      rate: 0.2,
      capMonthlySgd: 600,
    });
    expect(result.card.milesPerDollar).toBeUndefined();
    expect(result.card.annualFeeSgd).toBe(0);
    expect(result.card.sourceNote).toBe(
      "User-entered terms. Not verified against any issuer.",
    );
  });

  it("ignores a caller supplied sourceNote and still forces the disclaimer", () => {
    const result = parseCustomCard({ ...validInput, name: "Tampered", sourceNote: "Verified by UOB." });
    if (!result.ok) {
      throw new Error(result.errors.join(" | "));
    }
    expect(result.card.sourceNote).toBe("User-entered terms. Not verified against any issuer.");
  });

  it("rejects a negative tier rate with a human-readable error naming the field", () => {
    const result = parseCustomCard({
      ...validInput,
      earnStructure: [{ category: "groceries", rate: -0.01 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join(" | ");
      expect(joined).toContain("earnStructure.0.rate");
      expect(joined).toMatch(/between 0 and 0\.2/);
    }
  });

  it("rejects a miles card entered without milesPerDollar", () => {
    const result = parseCustomCard({ ...validInput, rewardType: "miles" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.join(" | ")).toContain("milesPerDollar is required");
    }
  });

  it("rejects duplicate tier categories with an error naming the repeated category", () => {
    const result = parseCustomCard({
      ...validInput,
      earnStructure: [
        { category: "dining", rate: 0.05 },
        { category: "dining", rate: 0.03 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join(" | ");
      expect(joined).toContain("dining");
      expect(joined).toMatch(/different category/);
      for (const error of result.errors) {
        expect(error.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("ships blank form defaults that parse cleanly once a name is filled in", () => {
    const draft = blankCustomCardDraft();
    expect(draft.rewardType).toBe("cashback");
    expect(draft.earnStructure).toEqual([]);

    const named = parseCustomCard({ ...draft, name: "Blank Draft Card" });
    if (!named.ok) {
      throw new Error(named.errors.join(" | "));
    }
    expect(named.card.issuer).toBe("Personal");
    expect(named.card.baseRate).toBe(0.01);
    expect(named.card.minMonthlySpendSgd).toBeUndefined();
  });
});

describe("mergeCards", () => {
  const build = (name: string): CardSpec => {
    const parsed = parseCustomCard({
      name,
      rewardType: "cashback",
      baseRate: 0.005,
      earnStructure: [],
      annualFeeSgd: 0,
    });
    if (!parsed.ok) {
      throw new Error(parsed.errors.join(" | "));
    }
    return parsed.card;
  };

  it("appends custom cards after the built-ins in order and suffixes a colliding id with -2", () => {
    const colliding = build("UOB One"); // slugs to the built-in id uob-one
    const plain = build("Plain Custom");

    const merged = mergeCards(CARDS, [colliding, plain]);

    expect(merged).toHaveLength(CARDS.length + 2);
    expect(merged.slice(0, CARDS.length)).toEqual(CARDS); // built-ins untouched and first
    expect(merged[CARDS.length]?.id).toBe("uob-one-2");
    expect(merged[CARDS.length]?.name).toBe("UOB One");
    expect(merged[CARDS.length + 1]?.id).toBe("plain-custom");

    const ids = merged.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates anywhere
    expect(CARDS.map((card) => card.id)).not.toContain("uob-one-2"); // inputs not mutated
  });

  it("routes a groceries purchase to the custom card when its tier beats the whole merged deck", () => {
    const parsed = parseCustomCard({
      name: "My Grocery Card",
      rewardType: "cashback",
      baseRate: 0.003,
      earnStructure: [{ category: "groceries", rate: 0.2 }],
      annualFeeSgd: 0,
    });
    if (!parsed.ok) {
      throw new Error(parsed.errors.join(" | "));
    }

    const deck = mergeCards(CARDS, [parsed.card]);
    const recs = routeExpense(
      deck,
      { amountSgd: 300, category: "groceries" },
      { monthKey: MONTH, entries: [] },
    );

    expect(recs).toHaveLength(CARDS.length + 1);
    expect(recs[0]?.cardId).toBe("my-grocery-card"); // 20% of 300 = S$60.00, ahead of every built-in
    expect(recs[0]?.rewardValueSgd).toBeCloseTo(60.0, 2);
    expect(recs[0]?.conditional).toBe(false);
  });
});

describe("explainMisses", () => {
  const misses: AuditMiss[] = [
    {
      index: 0,
      usedCardId: "uob-one",
      bestCardId: "hsbc-live-plus",
      lostSgd: 7.0,
      why:
        "S$100.00 on dining: UOB One Card earned S$1.00 (used card paid base rate with no bonus tier for this category); best card hsbc-live-plus would have earned S$8.00",
    },
    {
      index: 1,
      usedCardId: "dbs-live-fresh",
      bestCardId: "hsbc-live-plus",
      lostSgd: 3.0,
      why:
        "S$50.00 on dining: DBS Live Fresh Card earned S$1.50 (used card paid base rate with no bonus tier for this category); best card hsbc-live-plus would have earned S$4.50",
    },
  ];
  const context = {
    monthKey: MONTH,
    cardNames: {
      "uob-one": "UOB One Card",
      "dbs-live-fresh": "DBS Live Fresh Card",
      "hsbc-live-plus": "HSBC Live+ Card",
    },
  };

  it("returns the deterministic engine with null explanations when the model path yields nothing", async () => {
    const result = await explainMisses(misses, context, async () => null);
    expect(result.engine).toBe("deterministic");
    expect(result.explanations).toBeNull();
  });

  it("returns ultra with exactly one explanation per miss when the reply is well formed", async () => {
    const calls: Array<{ system: string; user: string; model: string }> = [];
    const result = await explainMisses(misses, context, async (system, user, model) => {
      calls.push({ system, user, model });
      return {
        explanations: [
          "You spent S$100.00 on dining on the UOB One Card, which has no dining bonus tier, so it paid S$1.00 while the HSBC Live+ Card would have paid S$8.00, costing you S$7.00.",
          "You spent S$50.00 on dining on the DBS Live Fresh Card, which has no dining bonus tier, so it paid S$1.50 while the HSBC Live+ Card would have paid S$4.50, costing you S$3.00.",
        ],
      };
    });

    expect(result.engine).toBe("ultra");
    expect(result.explanations).toHaveLength(misses.length);
    const explanations = result.explanations ?? [];
    expect(explanations[0]).toContain("S$7.00"); // figures copied verbatim from the misses
    expect(explanations[1]).toContain("S$3.00");
    for (const explanation of explanations) {
      expect(explanation.trim().length).toBeGreaterThan(0);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(ultraModel());
    expect(calls[0]?.system).toContain("explanations");
    expect(calls[0]?.user).toContain('"monthKey":"2025-03"');
    expect(calls[0]?.user).toContain("HSBC Live+ Card");
  });

  it("falls back to deterministic when the reply has the wrong length, bad shape, or the fetcher throws", async () => {
    const tooFew = await explainMisses(misses, context, async () => ({
      explanations: ["only one explanation for two misses"],
    }));
    expect(tooFew).toEqual({ engine: "deterministic", explanations: null });

    const badShape = await explainMisses(misses, context, async () => ({ notes: [] }));
    expect(badShape).toEqual({ engine: "deterministic", explanations: null });

    const threw = await explainMisses(misses, context, async () => {
      throw new Error("network down");
    });
    expect(threw).toEqual({ engine: "deterministic", explanations: null });
  });
});
