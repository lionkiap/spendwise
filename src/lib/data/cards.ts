import type { CardSpec } from "../cards/types";

/**
 * Illustrative Singapore credit card terms, published-style but simplified.
 * Every number here is demo data for a hackathon MVP: rates, caps, minimum
 * spends and exclusions change constantly and each card carries a sourceNote
 * stating that terms must be verified with the issuer.
 */
export const CARDS: CardSpec[] = [
  {
    id: "uob-one",
    issuer: "United Overseas Bank",
    name: "UOB One Card",
    rewardType: "cashback",
    earnStructure: [
      {
        category: "groceries",
        rate: 0.0667,
        capMonthlySgd: 600,
        note: "Bonus applies up to S$600 monthly grocery spend at participating merchants",
      },
      {
        category: "transport",
        rate: 0.0667,
        capMonthlySgd: 600,
        note: "Bonus applies up to S$600 monthly transport spend including ride-hail and transit",
      },
    ],
    baseRate: 0.0333,
    minMonthlySpendSgd: 500,
    minSpendNote:
      "S$500 monthly spend required for the 3.33% base rate and 6.67% bonus tiers",
    annualFeeSgd: 192.6,
    sourceNote:
      "Illustrative terms as of 2025; verify current rates, caps and exclusions with UOB before relying on them.",
  },
  {
    id: "citi-cash-back-plus",
    issuer: "Citibank Singapore",
    name: "Citi Cash Back+ Card",
    rewardType: "cashback",
    earnStructure: [
      {
        category: "groceries",
        rate: 0.016,
        capMonthlySgd: 1000,
        note: "1.6% on grocery spend up to S$1,000 per month",
      },
      {
        category: "online_shopping",
        rate: 0.016,
        capMonthlySgd: 1000,
        note: "1.6% on online spend up to S$1,000 per month, excludes travel and bill payments",
      },
    ],
    baseRate: 0.005,
    minMonthlySpendSgd: 800,
    minSpendNote: "S$800 monthly spend required for the 1.6% bonus tiers",
    annualFeeSgd: 194.4,
    sourceNote:
      "Illustrative terms as of 2025; verify current rates, caps and exclusions with Citibank before relying on them.",
  },
  {
    id: "dbs-live-fresh",
    issuer: "DBS Bank",
    name: "DBS Live Fresh Card",
    rewardType: "cashback",
    earnStructure: [
      {
        category: "online_shopping",
        rate: 0.06,
        capMonthlySgd: 1000,
        note: "6% on online spend up to S$1,000 per month, excludes grab pay and travel",
      },
      {
        category: "transport",
        rate: 0.06,
        capMonthlySgd: 1000,
        note: "6% on contactless transit and ride-hail up to S$1,000 per month",
      },
    ],
    baseRate: 0.003,
    minMonthlySpendSgd: 500,
    minSpendNote: "S$500 monthly spend required for the 6% online and contactless tiers",
    annualFeeSgd: 192.6,
    sourceNote:
      "Illustrative terms as of 2025; verify current rates, caps and exclusions with DBS before relying on them.",
  },
  {
    id: "hsbc-live-plus",
    issuer: "HSBC Singapore",
    name: "HSBC Live+ Card",
    rewardType: "cashback",
    earnStructure: [
      {
        category: "dining",
        rate: 0.08,
        capMonthlySgd: 1250,
        note: "8% on dining, shared S$1,250 monthly cap with groceries",
      },
      {
        category: "groceries",
        rate: 0.08,
        capMonthlySgd: 1250,
        note: "8% on groceries, shared S$1,250 monthly cap with dining",
      },
    ],
    baseRate: 0.005,
    annualFeeSgd: 120,
    sourceNote:
      "Illustrative terms as of 2025; verify current rates, caps and exclusions with HSBC before relying on them.",
  },
  {
    id: "amex-true-cashback",
    issuer: "American Express Singapore",
    name: "Amex True Cashback Card",
    rewardType: "cashback",
    earnStructure: [],
    baseRate: 0.015,
    annualFeeSgd: 0,
    sourceNote:
      "Illustrative terms as of 2025; verify current rates and exclusions with American Express before relying on them.",
  },
  {
    id: "sc-simply-cash",
    issuer: "Standard Chartered Singapore",
    name: "Standard Chartered Simply Cash Card",
    rewardType: "cashback",
    earnStructure: [],
    baseRate: 0.015,
    annualFeeSgd: 196.2,
    sourceNote:
      "Illustrative terms as of 2025; verify current rates and exclusions with Standard Chartered before relying on them.",
  },
  {
    id: "ocbc-titanium-rewards",
    issuer: "OCBC Bank",
    name: "OCBC Titanium Rewards Card",
    rewardType: "cashback",
    earnStructure: [
      {
        category: "online_shopping",
        rate: 0.04,
        capMonthlySgd: 1667,
        note: "10X OCR points expressed as a 4% cashback equivalent, up to S$1,667 monthly online spend",
      },
    ],
    baseRate: 0.003,
    minMonthlySpendSgd: 800,
    minSpendNote: "S$800 monthly spend required for the 4% online tier",
    annualFeeSgd: 192.6,
    sourceNote:
      "Illustrative terms as of 2025; points value and caps simplified; verify with OCBC before relying on them.",
  },
  {
    id: "citi-premiermiles",
    issuer: "Citibank Singapore",
    name: "Citi PremierMiles Card",
    rewardType: "miles",
    earnStructure: [
      {
        category: "travel",
        rate: 2.0,
        note: "2 miles per dollar on foreign currency and travel spend, uncapped",
      },
    ],
    baseRate: 1.2,
    milesPerDollar: 1.2,
    annualFeeSgd: 535.5,
    sourceNote:
      "Illustrative terms as of 2025; verify current earn rates and airline transfer terms with Citibank before relying on them.",
  },
  {
    id: "dbs-altitude",
    issuer: "DBS Bank",
    name: "DBS Altitude Visa Signature Card",
    rewardType: "miles",
    earnStructure: [
      {
        category: "travel",
        rate: 3.0,
        capMonthlySgd: 3000,
        note: "3 miles per dollar on online travel booked via DBS Travel, up to S$3,000 per month",
      },
    ],
    baseRate: 1.3,
    milesPerDollar: 1.3,
    annualFeeSgd: 192.6,
    sourceNote:
      "Illustrative terms as of 2025; verify current earn rates and caps with DBS before relying on them.",
  },
  {
    id: "uob-prvi-miles",
    issuer: "United Overseas Bank",
    name: "UOB PRVI Miles Card",
    rewardType: "miles",
    earnStructure: [
      {
        category: "travel",
        rate: 6.0,
        capMonthlySgd: 1000,
        note: "6 miles per dollar on flights and hotels booked via UOB Travel, up to S$1,000 per month",
      },
    ],
    baseRate: 1.4,
    milesPerDollar: 1.4,
    minMonthlySpendSgd: 1000,
    minSpendNote: "S$1,000 monthly spend required for the 6 mpd UOB Travel tier",
    annualFeeSgd: 267.55,
    sourceNote:
      "Illustrative terms as of 2025; verify current earn rates and booking-channel exclusions with UOB before relying on them.",
  },
  {
    id: "krisflyer-uob",
    issuer: "United Overseas Bank",
    name: "KrisFlyer UOB Credit Card",
    rewardType: "miles",
    earnStructure: [
      {
        category: "travel",
        rate: 3.0,
        note: "3 miles per dollar on Singapore Airlines Group and KrisShop spend, uncapped",
      },
      {
        category: "dining",
        rate: 3.0,
        capMonthlySgd: 800,
        note: "3 miles per dollar on dining, up to S$800 per month",
      },
    ],
    baseRate: 1.2,
    milesPerDollar: 1.2,
    minMonthlySpendSgd: 800,
    minSpendNote: "S$800 monthly spend required for the 3 mpd tiers",
    annualFeeSgd: 182.42,
    sourceNote:
      "Illustrative terms as of 2025; verify current earn rates with UOB and Singapore Airlines before relying on them.",
  },
  {
    id: "hsbc-revolution",
    issuer: "HSBC Singapore",
    name: "HSBC Revolution Credit Card",
    rewardType: "miles",
    earnStructure: [
      {
        category: "online_shopping",
        rate: 4.0,
        capMonthlySgd: 750,
        note: "4 miles per dollar on online purchases, shared S$750 monthly cap with transit",
      },
      {
        category: "transport",
        rate: 4.0,
        capMonthlySgd: 750,
        note: "4 miles per dollar on contactless transit, shared S$750 monthly cap with online",
      },
    ],
    baseRate: 0.4,
    milesPerDollar: 0.4,
    minMonthlySpendSgd: 500,
    minSpendNote: "S$500 monthly spend required for the 4 mpd tiers",
    annualFeeSgd: 0,
    sourceNote:
      "Illustrative terms as of 2025; rewards expressed as miles; verify conversion terms with HSBC before relying on them.",
  },
  {
    id: "maybank-horizon",
    issuer: "Maybank Singapore",
    name: "Maybank Horizon Visa Signature Card",
    rewardType: "miles",
    earnStructure: [
      {
        category: "travel",
        rate: 8.0,
        capMonthlySgd: 1000,
        note: "8 miles per dollar on airline transactions, up to S$1,000 per month",
      },
    ],
    baseRate: 3.2,
    milesPerDollar: 3.2,
    minMonthlySpendSgd: 800,
    minSpendNote: "S$800 monthly spend required for the 8 mpd airline tier",
    annualFeeSgd: 254.7,
    sourceNote:
      "Illustrative terms as of 2025; verify current earn rates and airline exclusions with Maybank before relying on them.",
  },
  {
    id: "sc-unlimited-cashback",
    issuer: "Standard Chartered Singapore",
    name: "Standard Chartered Unlimited Cashback Card",
    rewardType: "cashback",
    earnStructure: [],
    baseRate: 0.015,
    minMonthlySpendSgd: 500,
    minSpendNote: "S$500 monthly spend required for the flat 1.5% cashback",
    annualFeeSgd: 196.2,
    sourceNote:
      "Illustrative terms as of 2025; verify current rates and exclusions with Standard Chartered before relying on them.",
  },
];
