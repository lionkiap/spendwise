/**
 * Car ownership and financing kernels.
 *
 * The financing limits and fee estimates here are ILLUSTRATIVE SNAPSHOTS for
 * a hackathon MVP: verify against MAS and LTA rules before production use.
 */

export interface CarLoanLimits {
  /** Maximum loan-to-value allowed for a car at this open market value. */
  ltv: number;
  /** Maximum repayment tenor in years. */
  maxTenorYears: number;
}

/**
 * Vehicle financing caps by open market value (OMV), per the MAS rules for
 * motor vehicle loans.
 * Formula: when OMV is at most 20,000 the LTV cap is 0.7 with a 7 year
 * maximum tenor; above 20,000 the LTV cap is 0.6 with a 5 year maximum
 * tenor. Verified against mas.gov.sg; re-verify before production.
 */
export function carLoanLimits(openMarketValue: number): CarLoanLimits {
  return openMarketValue <= 20_000
    ? { ltv: 0.7, maxTenorYears: 7 }
    : { ltv: 0.6, maxTenorYears: 5 };
}

/**
 * Converts a car dealer flat rate into an approximate effective annual rate
 * using the constant-ratio approximation.
 * Formula: effective = 2 * n * flat / (n + 1), where n = years and
 * flat = flatRatePa. A flat rate charges interest on the full principal for
 * the whole tenure even though the principal is repaid monthly, so the true
 * rate is close to double the flat rate for typical car tenors.
 */
export function flatToEffective(flatRatePa: number, years: number): number {
  return (2 * years * flatRatePa) / (years + 1);
}

export interface TcoInputs {
  /** Total financing cost over the whole ownership, interest and fees. */
  loanCostTotal: number;
  insurancePerYear: number;
  roadTaxPerYear: number;
  /** Energy (petrol or electricity) cost per kilometre driven. */
  energyCostPerKm: number;
  annualKm: number;
  maintenancePerYear: number;
  ownershipYears: number;
}

export interface TcoYearly {
  loan: number;
  insurance: number;
  roadTax: number;
  energy: number;
  maintenance: number;
  total: number;
}

export interface TcoResult {
  /** Average cost per ownership year, by component and in total. */
  yearly: TcoYearly;
  /** Cost over the whole ownership: yearly.total * ownershipYears. */
  total: number;
}

/**
 * Yearly and total cost of owning one car.
 * Formula: energyPerYear = energyCostPerKm * annualKm;
 * yearly.loan = loanCostTotal / ownershipYears;
 * yearly.total = loanCostTotal / ownershipYears + insurancePerYear
 *                + roadTaxPerYear + energyPerYear + maintenancePerYear;
 * total = yearly.total * ownershipYears.
 */
export function tcoCompare(inputs: TcoInputs): TcoResult {
  const years = inputs.ownershipYears;
  const loan = years > 0 ? inputs.loanCostTotal / years : inputs.loanCostTotal;
  const insurance = inputs.insurancePerYear;
  const roadTax = inputs.roadTaxPerYear;
  const energy = inputs.energyCostPerKm * inputs.annualKm;
  const maintenance = inputs.maintenancePerYear;
  const yearlyTotal = loan + insurance + roadTax + energy + maintenance;
  return {
    yearly: { loan, insurance, roadTax, energy, maintenance, total: yearlyTotal },
    total: yearlyTotal * years,
  };
}
