/**
 * Singapore residential property cost kernels.
 *
 * Every duty table and rate in this file is an ILLUSTRATIVE SNAPSHOT for a
 * hackathon MVP. Stamp duties and financing rules are set by statute and
 * change over time: verify each figure against IRAS and MAS before any
 * production or advisory use. Nothing here is legal, tax or financial advice.
 */

export type AbsdCitizenship = 'citizen' | 'pr' | 'foreigner';

export interface AbsdProfile {
  citizenship: AbsdCitizenship;
  /** 1 for the property being bought now, 2 for the second and so on. */
  propertyCount: number;
}

/** Marginal buyer stamp duty tiers for Singapore residential property. */
const BSD_TIERS: ReadonlyArray<{ upTo: number; rate: number }> = [
  { upTo: 180_000, rate: 0.01 },
  { upTo: 360_000, rate: 0.02 },
  { upTo: 1_000_000, rate: 0.03 },
  { upTo: 1_500_000, rate: 0.04 },
  { upTo: 2_000_000, rate: 0.05 },
  { upTo: 3_000_000, rate: 0.06 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.06 },
];

/**
 * Buyer stamp duty on a Singapore residential purchase.
 * Formula: BSD = sum over tiers of (portion of price inside the tier) * tier rate,
 * with tiers as marginal brackets, not as a rate applied to the whole price.
 * Statutory residential tiers in force since 15 Feb 2023 (iras.gov.sg):
 * 1 percent of the first 180k, 2 percent of the next 180k, 3 percent of the
 * next 640k, 4 percent up to 1.5m, 5 percent up to 2m and 6 percent from 3m.
 * Re-verify on iras.gov.sg before production.
 */
export function bsd(price: number): number {
  let duty = 0;
  let lowerBound = 0;
  for (const tier of BSD_TIERS) {
    if (price <= lowerBound) {
      break;
    }
    const amountInTier = Math.min(price, tier.upTo) - lowerBound;
    duty += amountInTier * tier.rate;
    lowerBound = tier.upTo;
  }
  return duty;
}

/**
 * ABSD rate table by citizenship, indexed by (propertyCount - 1).
 * Counts beyond the table clamp to the last rate. Snapshot rates
 * (verify on iras.gov.sg before production): Singapore citizen 2nd property
 * 20 percent and 3rd plus 30 percent, PR first 5 percent, foreigner 60 percent.
 */
const ABSD_RATES: Record<AbsdCitizenship, ReadonlyArray<number>> = {
  citizen: [0, 0.2, 0.3],
  pr: [0.05, 0.3, 0.35],
  foreigner: [0.6],
};

/**
 * Additional buyer stamp duty on a residential purchase.
 * Formula: ABSD = price * rate(citizenship, propertyCount), where the rate is
 * read from the snapshot table above with the count clamped to its last entry.
 */
export function absd(price: number, profile: AbsdProfile): number {
  const rates = ABSD_RATES[profile.citizenship];
  const index = Math.max(0, Math.min(profile.propertyCount - 1, rates.length - 1));
  return price * rates[index];
}

export interface DownPaymentSplit {
  /** Full down payment in dollars: price * (1 - ltvLimit). */
  total: number;
  /** Cash that must be paid upfront regardless of CPF: 5 percent of price. */
  minCash: number;
  /** Remainder of the down payment that CPF savings can cover. */
  cpfPortion: number;
}

/**
 * Splits a residential down payment into the minimum cash leg and the
 * CPF-coverable leg.
 * Formula: total = price * (1 - ltvLimit); minCash = 0.05 * price;
 * cpfPortion = max(total - minCash, 0).
 * ltvLimit defaults to 0.75, the MAS loan-to-value frame for the first loan.
 */
export function downPaymentSplit(price: number, ltvLimit = 0.75): DownPaymentSplit {
  const total = price * (1 - ltvLimit);
  const minCash = price * 0.05;
  const cpfPortion = Math.max(total - minCash, 0);
  return { total, minCash, cpfPortion };
}

export interface AffordabilityCheck {
  pass: boolean;
  /** monthlyAmount / grossMonthlyIncome, Infinity when income is not positive. */
  ratio: number;
  /** The regulatory ratio the check passes at, e.g. 0.3 or 0.55. */
  limitRatio: number;
}

function checkRatio(monthlyAmount: number, grossMonthlyIncome: number, limitRatio: number): AffordabilityCheck {
  const ratio = grossMonthlyIncome > 0 ? monthlyAmount / grossMonthlyIncome : Number.POSITIVE_INFINITY;
  return { pass: ratio <= limitRatio, ratio, limitRatio };
}

/**
 * Mortgage Servicing Ratio check: the property installment may take at most
 * 30 percent of gross monthly income (MAS MSR frame).
 * Formula: ratio = monthlyInstallment / grossMonthlyIncome; pass = ratio <= 0.30
 */
export function msrCheck(monthlyInstallment: number, grossMonthlyIncome: number): AffordabilityCheck {
  return checkRatio(monthlyInstallment, grossMonthlyIncome, 0.3);
}

/**
 * Total Debt Servicing Ratio check: all monthly debt obligations together may
 * take at most 55 percent of gross monthly income (MAS TDSR frame).
 * Formula: ratio = totalMonthlyDebt / grossMonthlyIncome; pass = ratio <= 0.55
 */
export function tdsrCheck(totalMonthlyDebt: number, grossMonthlyIncome: number): AffordabilityCheck {
  return checkRatio(totalMonthlyDebt, grossMonthlyIncome, 0.55);
}

/** Flat-fee conveyancing estimate tiers by price bound. */
const LEGAL_FEE_TIERS: ReadonlyArray<{ upTo: number; fee: number }> = [
  { upTo: 300_000, fee: 2_200 },
  { upTo: 600_000, fee: 2_800 },
  { upTo: 1_000_000, fee: 3_500 },
  { upTo: Number.POSITIVE_INFINITY, fee: 4_200 },
];

/**
 * Rough conveyancing legal fee estimate, a flat fee picked by price tier.
 * Formula: fee = the fee of the first tier whose upTo bound is at least price.
 * Illustrative snapshot only: actual quotes from law firms vary.
 */
export function legalFeesEstimate(price: number): number {
  for (const tier of LEGAL_FEE_TIERS) {
    if (price <= tier.upTo) {
      return tier.fee;
    }
  }
  return LEGAL_FEE_TIERS[LEGAL_FEE_TIERS.length - 1].fee;
}
