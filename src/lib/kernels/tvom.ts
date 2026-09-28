/**
 * Time value of money kernels.
 *
 * Conventions: rates are annual nominal rates compounded monthly, terms are
 * whole months, payments are level and paid at the end of each month
 * (ordinary annuity). Every function here is pure: no IO, no globals, no
 * Date and no Math.random. Money is always in one consistent currency unit.
 */

/** Monthly rate i = ratePa / 12. */
function monthlyRate(ratePa: number): number {
  return ratePa / 12;
}

/** Compounding factor (1 + i)^n for a monthly rate i over n months. */
function growthFactor(i: number, months: number): number {
  return Math.pow(1 + i, months);
}

/**
 * Annuity factor s(n, i) = ((1 + i)^n - 1) / i: the future value after n
 * months of 1 paid at the end of each month. At i = 0 it degenerates to n.
 */
function annuityFactor(i: number, months: number): number {
  if (i === 0) {
    return months;
  }
  return (growthFactor(i, months) - 1) / i;
}

/**
 * Future value of a lump sum with monthly compounding.
 * Formula: FV = PV * (1 + ratePa / 12) ^ (years * 12)
 */
export function fvLump(pv: number, ratePa: number, years: number): number {
  const n = Math.round(years * 12);
  return pv * growthFactor(monthlyRate(ratePa), n);
}

/**
 * Future value of an ordinary annuity of level end-of-month payments.
 * Formula: FV = PMT * (((1 + ratePa / 12)^months - 1) / (ratePa / 12))
 */
export function fvAnnuity(pmt: number, ratePa: number, months: number): number {
  return pmt * annuityFactor(monthlyRate(ratePa), months);
}

/**
 * Level end-of-month payment needed so a lump sum PV plus the payment stream
 * reaches target after months. Returns NaN when months is not positive.
 * Formula: PMT = (target - PV * (1 + ratePa/12)^months)
 *               / (((1 + ratePa/12)^months - 1) / (ratePa/12))
 */
export function pmtForFv(target: number, pv: number, ratePa: number, months: number): number {
  const i = monthlyRate(ratePa);
  const af = annuityFactor(i, months);
  if (af === 0) {
    return NaN;
  }
  const lumpFv = pv * growthFactor(i, months);
  return (target - lumpFv) / af;
}

/**
 * Annual nominal rate (monthly compounding) at which PV plus a level
 * end-of-month annuity of PMT grows to exactly target over the given months,
 * solved by bisection on the annual rate.
 * Formula: f(r) = PV * (1 + r/12)^months
 *                + PMT * (((1 + r/12)^months - 1) / (r/12)) - target = 0
 * f is strictly increasing in r when PV and PMT are nonnegative, so bisection
 * converges. The rate is floored at 0 when the contributions alone already
 * reach target and NaN when no tested rate can reach it.
 */
export function rateForFv(target: number, pv: number, pmt: number, months: number): number {
  const f = (ratePa: number): number =>
    pv * growthFactor(monthlyRate(ratePa), months) +
    pmt * annuityFactor(monthlyRate(ratePa), months) -
    target;

  let lo = 0;
  let hi = 1; // start with a bracket of 0 to 100 percent per annum
  let expansions = 0;
  while (f(hi) < 0 && expansions < 60) {
    hi *= 2;
    expansions += 1;
  }
  if (f(hi) < 0) {
    return NaN; // target unreachable even at an astronomic rate
  }
  if (f(lo) >= 0) {
    return 0; // contributions alone already reach target
  }
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo <= 1e-12) {
      break;
    }
  }
  return (lo + hi) / 2;
}

export interface AmortizeYear {
  /** 1-based loan year this row covers. */
  year: number;
  principalPaid: number;
  interestPaid: number;
  /** Outstanding balance at the end of the loan year. */
  endBalance: number;
}

export interface AmortizeResult {
  monthlyPayment: number;
  totalInterest: number;
  /** One row per loan year; the last row may be a partial year. */
  schedule: AmortizeYear[];
}

/**
 * Level-payment loan amortization with monthly compounding.
 * Formula: PMT = P * i / (1 - (1 + i)^-n), where i = ratePa / 12 and
 * n = years * 12. Total interest = PMT * n - P. The schedule walks the
 * balance month by month with interest(m) = B(m-1) * i,
 * principal(m) = PMT - interest(m), B(m) = B(m-1) - principal(m) and
 * aggregates the months into whole-year rows.
 */
export function amortize(principal: number, ratePa: number, years: number): AmortizeResult {
  const n = Math.round(years * 12);
  if (n <= 0) {
    return { monthlyPayment: 0, totalInterest: 0, schedule: [] };
  }
  const i = monthlyRate(ratePa);
  const monthlyPayment = i === 0 ? principal / n : (principal * i) / (1 - Math.pow(1 + i, -n));
  const totalInterest = monthlyPayment * n - principal;

  const schedule: AmortizeYear[] = [];
  let balance = principal;
  let yearPrincipal = 0;
  let yearInterest = 0;
  for (let m = 1; m <= n; m += 1) {
    const interest = balance * i;
    const principalPart = Math.min(monthlyPayment - interest, Math.max(balance, 0));
    balance -= principalPart;
    yearPrincipal += principalPart;
    yearInterest += interest;
    if (m % 12 === 0 || m === n) {
      schedule.push({
        year: Math.ceil(m / 12),
        principalPaid: yearPrincipal,
        interestPaid: yearInterest,
        endBalance: Math.max(balance, 0),
      });
      yearPrincipal = 0;
      yearInterest = 0;
    }
  }
  return { monthlyPayment, totalInterest, schedule };
}

/**
 * Present purchasing power of a nominal amount after years of inflation.
 * Formula: real = nominal / (1 + inflationPa)^years
 */
export function realValue(nominalAmount: number, inflationPa: number, years: number): number {
  return nominalAmount / Math.pow(1 + inflationPa, years);
}
