/**
 * CPF (Central Provident Fund) Ordinary Account kernels.
 *
 * Pure deterministic projections. The OA floor rate of 2.5 percent per annum
 * is the default rate, but every figure here is a simplification of the real
 * Extra Interest and Contribution Allocation rules: verify against the CPF
 * Board before production or advisory use.
 */

export interface OaYear {
  /** 1-based projection year this balance belongs to. */
  year: number;
  /** Ordinary Account balance at the end of the year. */
  balance: number;
}

/**
 * Projects an Ordinary Account balance with a fixed monthly contribution.
 * Formula (monthly recursion, interest credited at month end):
 * B(m) = B(m-1) * (1 + rate / 12) + monthlyContribution,
 * sampled once per year at B(12k) for k = 1 to years.
 */
export function oaProjection(
  balance: number,
  monthlyContribution: number,
  years: number,
  rate = 0.025
): OaYear[] {
  const months = Math.round(years * 12);
  const i = rate / 12;
  const projection: OaYear[] = [];
  let b = balance;
  for (let m = 1; m <= months; m += 1) {
    b = b * (1 + i) + monthlyContribution;
    if (m % 12 === 0) {
      projection.push({ year: m / 12, balance: b });
    }
  }
  return projection;
}

/**
 * Compound interest foregone by drawing a lump sum out of CPF OA and holding
 * it as cash for a horizon of yearsToDepletion years.
 * Formula: cost = amountDrawn * ((1 + rate / 12)^(12 * yearsToDepletion) - 1)
 * Interpretation: the drawn amount would have compounded monthly at the OA
 * rate until the account depletes, so the true cost of spending it is the
 * growth it never earns, not the nominal amount itself.
 */
export function opportunityCostOfCpf(
  amountDrawn: number,
  yearsToDepletion: number,
  rate = 0.025
): number {
  const months = Math.round(yearsToDepletion * 12);
  return amountDrawn * (Math.pow(1 + rate / 12, months) - 1);
}

/**
 * Employee share of the CPF contribution on a gross monthly salary.
 * Formula: contribution = 0.20 * min(grossMonthlyIncome, 6000)
 *
 * Snapshot of the ordinary-wage rules the planner models: the employee
 * contributes 20 percent of ordinary wages, and only wages up to the CPF
 * ordinary-wage ceiling of 6,000 SGD a month attract contributions. The Board
 * revises both the share by age band and the ceiling over time, so re-verify
 * against cpf.gov.sg before production or advisory use. The employer share is
 * deliberately excluded: it never passes through the saver's bank account, so
 * it does not reduce the cash available to save.
 */
export function employeeCpfContribution(grossMonthlyIncome: number): number {
  return 0.2 * Math.min(grossMonthlyIncome, 6_000);
}
