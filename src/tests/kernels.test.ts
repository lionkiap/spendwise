import { describe, expect, it } from 'vitest';
import {
  absd,
  amortize,
  bsd,
  carLoanLimits,
  downPaymentSplit,
  flatToEffective,
  fvAnnuity,
  fvLump,
  legalFeesEstimate,
  msrCheck,
  oaProjection,
  opportunityCostOfCpf,
  pmtForFv,
  rateForFv,
  realValue,
  tcoCompare,
  tdsrCheck,
} from '../lib/kernels';

/**
 * Asserts actual lies within relTol (default 1.5 percent) of expected,
 * matching the tolerance budget the acceptance gate allows for.
 */
function expectNear(actual: number, expected: number, relTol = 0.015): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * relTol);
}

describe('tvom', () => {
  it('fvLump compounds monthly: 5000 at 1.8 percent pa for 28 years is about 8273', () => {
    expectNear(fvLump(5000, 0.018, 28), 8273);
  });

  it('fvAnnuity: 500 a month at 1.8 percent pa for 12 months is about 6050', () => {
    expectNear(fvAnnuity(500, 0.018, 12), 6049.83);
  });

  it('fvAnnuity at 0 percent is payment times months', () => {
    expect(fvAnnuity(500, 0, 12)).toBeCloseTo(6000, 9);
  });

  it('pmtForFv: 1M target from 5000 at 1.8 percent pa over 336 months pays 2240 to 2305', () => {
    const pmt = pmtForFv(1_000_000, 5000, 0.018, 336);
    expect(pmt).toBeGreaterThan(2240);
    expect(pmt).toBeLessThan(2305);
  });

  it('rateForFv inverts pmtForFv and recovers 1.8 percent pa from the scenario', () => {
    const pmt = pmtForFv(1_000_000, 5000, 0.018, 336);
    expectNear(rateForFv(1_000_000, 5000, pmt, 336), 0.018);
  });

  it('roundtrip: rateForFv then fvLump plus fvAnnuity reproduces the target within 2 percent', () => {
    const target = 1_000_000;
    const rate = rateForFv(target, 10_000, 800, 240);
    const reproduced = fvLump(10_000, rate, 240 / 12) + fvAnnuity(800, rate, 240);
    expect(Math.abs(reproduced - target)).toBeLessThanOrEqual(0.02 * target);
  });

  it('roundtrip from a zero lump reproduces the target within 2 percent', () => {
    const target = 250_000;
    const rate = rateForFv(target, 0, 300, 120);
    const reproduced = fvLump(0, rate, 120 / 12) + fvAnnuity(300, rate, 120);
    expect(Math.abs(reproduced - target)).toBeLessThanOrEqual(0.02 * target);
  });

  it('amortize: 450k at 2.6 percent pa over 25 years costs 2020 to 2065 a month', () => {
    const result = amortize(450_000, 0.026, 25);
    expect(result.monthlyPayment).toBeGreaterThan(2020);
    expect(result.monthlyPayment).toBeLessThan(2065);
    expectNear(result.totalInterest, result.monthlyPayment * 300 - 450_000, 0.001);
  });

  it('amortize schedule pays the principal down to zero', () => {
    const result = amortize(450_000, 0.026, 25);
    expect(result.schedule).toHaveLength(25);
    const principalPaid = result.schedule.reduce((sum, row) => sum + row.principalPaid, 0);
    expectNear(principalPaid, 450_000, 0.001);
    expect(result.schedule[24].endBalance).toBeCloseTo(0, 6);
    for (const row of result.schedule) {
      expectNear(row.principalPaid + row.interestPaid, 12 * result.monthlyPayment, 0.001);
    }
  });

  it('realValue deflates 100k at 3 percent pa for 10 years to about 74409', () => {
    expectNear(realValue(100_000, 0.03, 10), 74_409.39);
  });
});

describe('property', () => {
  it('bsd at 600k is exactly 12600', () => {
    expect(bsd(600_000)).toBe(12_600);
  });

  it('bsd tier boundaries and the top bracket hold by hand', () => {
    expect(bsd(55_000)).toBe(550);
    // 1800 + 3600 + 19200 + 20000
    expect(bsd(1_500_000)).toBe(44_600);
  });

  it('absd applies the snapshot rates by citizenship and count', () => {
    const price = 600_000;
    expect(absd(price, { citizenship: 'citizen', propertyCount: 1 })).toBeCloseTo(0, 9);
    expect(absd(price, { citizenship: 'citizen', propertyCount: 2 })).toBeCloseTo(120_000, 6);
    expect(absd(price, { citizenship: 'citizen', propertyCount: 3 })).toBeCloseTo(180_000, 6);
    expect(absd(price, { citizenship: 'citizen', propertyCount: 7 })).toBeCloseTo(180_000, 6);
    expect(absd(price, { citizenship: 'pr', propertyCount: 1 })).toBeCloseTo(30_000, 6);
    expect(absd(price, { citizenship: 'foreigner', propertyCount: 1 })).toBeCloseTo(360_000, 6);
  });

  it('downPaymentSplit at the default 75 percent LTV: 150000 total, 30000 cash, 120000 CPF', () => {
    const split = downPaymentSplit(600_000);
    expect(split.total).toBe(150_000);
    expect(split.minCash).toBe(30_000);
    expect(split.cpfPortion).toBe(120_000);
  });

  it('downPaymentSplit honours a custom LTV limit', () => {
    const split = downPaymentSplit(1_000_000, 0.55);
    expect(split.total).toBeCloseTo(450_000, 6);
    expect(split.minCash).toBeCloseTo(50_000, 6);
    expect(split.cpfPortion).toBeCloseTo(400_000, 6);
  });

  it('msrCheck passes at 30 percent of income and fails above', () => {
    expect(msrCheck(3000, 10_000).pass).toBe(true);
    expect(msrCheck(3000, 10_000).ratio).toBeCloseTo(0.3, 9);
    expect(msrCheck(3001, 10_000).pass).toBe(false);
  });

  it('tdsrCheck passes at 55 percent of income and fails above', () => {
    expect(tdsrCheck(5500, 10_000).pass).toBe(true);
    expect(tdsrCheck(5600, 10_000).pass).toBe(false);
  });

  it('legalFeesEstimate is tiered by price', () => {
    expect(legalFeesEstimate(250_000)).toBe(2_200);
    expect(legalFeesEstimate(500_000)).toBe(2_800);
    expect(legalFeesEstimate(900_000)).toBe(3_500);
    expect(legalFeesEstimate(1_500_000)).toBe(4_200);
  });
});

describe('cpf', () => {
  it('oaProjection at 0 percent adds contributions only', () => {
    const rows = oaProjection(50_000, 500, 3, 0);
    expect(rows).toHaveLength(3);
    expect(rows[0].year).toBe(1);
    expect(rows[0].balance).toBeCloseTo(56_000, 6);
    expect(rows[1].balance).toBeCloseTo(62_000, 6);
    expect(rows[2].year).toBe(3);
    expect(rows[2].balance).toBeCloseTo(68_000, 6);
  });

  it('oaProjection compounds 100 a month at the 2.5 percent default to about 2458 after 2 years', () => {
    const rows = oaProjection(0, 100, 2);
    expect(rows).toHaveLength(2);
    expectNear(rows[1].balance, 2_458.37);
  });

  it('opportunityCostOfCpf is the compound interest foregone on 20k over 10 years', () => {
    expectNear(opportunityCostOfCpf(20_000, 10, 0.025), 5_673.8);
    expectNear(opportunityCostOfCpf(20_000, 10), 5_673.8);
    expect(opportunityCostOfCpf(20_000, 0, 0.025)).toBeCloseTo(0, 9);
  });
});

describe('car', () => {
  it('carLoanLimits: 70 percent LTV and 7 year tenor at OMV up to 20k, 60 percent and 5 years above', () => {
    expect(carLoanLimits(15_000)).toEqual({ ltv: 0.7, maxTenorYears: 7 });
    expect(carLoanLimits(20_000)).toEqual({ ltv: 0.7, maxTenorYears: 7 });
    expect(carLoanLimits(20_001)).toEqual({ ltv: 0.6, maxTenorYears: 5 });
  });

  it('flatToEffective: 2.7 percent flat over 7 years is between 0.046 and 0.049', () => {
    const eff = flatToEffective(0.027, 7);
    expect(eff).toBeGreaterThan(0.046);
    expect(eff).toBeLessThan(0.049);
    expect(eff).toBeCloseTo(0.04725, 9);
  });

  it('tcoCompare totals yearly and lifetime cost of ownership', () => {
    const result = tcoCompare({
      loanCostTotal: 70_000,
      insurancePerYear: 2_000,
      roadTaxPerYear: 1_000,
      energyCostPerKm: 0.1,
      annualKm: 20_000,
      maintenancePerYear: 1_500,
      ownershipYears: 10,
    });
    expect(result.yearly.loan).toBeCloseTo(7_000, 6);
    expect(result.yearly.insurance).toBeCloseTo(2_000, 6);
    expect(result.yearly.roadTax).toBeCloseTo(1_000, 6);
    expect(result.yearly.energy).toBeCloseTo(2_000, 6);
    expect(result.yearly.maintenance).toBeCloseTo(1_500, 6);
    expect(result.yearly.total).toBeCloseTo(13_500, 6);
    expect(result.total).toBeCloseTo(135_000, 6);
  });
});
