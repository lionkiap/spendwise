/**
 * Deterministic plan builder: turns a validated GoalSpec plus the user
 * profile and the assumption list into the PlanJSON the UI renders.
 *
 * Every figure below is computed by the pure kernels in src/lib/kernels; this
 * file only orchestrates them and writes the words around the numbers. The
 * LLM never touches a figure.
 */
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
  realValue,
  tdsrCheck,
  type AffordabilityCheck,
} from '../kernels';
import {
  ILLUSTRATIVE_CAR_PRICE_SGD,
  ILLUSTRATIVE_PROPERTY_PRICE_SGD,
  PLANNER_DEFAULTS,
  type Assumption,
  type CarPurchaseGoal,
  type GoalSpec,
  type PropertyPurchaseGoal,
  type PropertyType,
  type SavingsTargetGoal,
  type UserProfile,
} from './goalspec';

export type VerdictStatus = 'achievable' | 'stretch' | 'not_achievable';

export interface PlanVerdict {
  status: VerdictStatus;
  headline: string;
  reasoning: string;
}

export interface SavingsScheduleRow {
  year: number;
  contributions: number;
  interest: number;
  balance: number;
}

export interface CostStackRow {
  label: string;
  amountSgd: number;
  note: string;
}

export interface RateInstallment {
  ratePa: number;
  tenorYears: number;
  monthlyInstallment: number;
}

export interface DebtPlan {
  loanPrincipalSgd: number;
  /** Baseline installment from the amortize kernel. */
  concessionary: RateInstallment;
  /** Stress tested installment from the amortize kernel. */
  stress: RateInstallment;
  msr: AffordabilityCheck;
  tdsr: AffordabilityCheck;
}

export interface ScenarioCell {
  /** Annual rate offset in decimals, for example -0.01 for one point down. */
  rateDelta: number;
  /** Fraction below or above the planned monthly saving, for example -0.2. */
  contributionDelta: number;
  /** The monthly saving actually made in this scenario. */
  monthlySgd: number;
  /** Projected balance at the deadline under this scenario. */
  balanceSgd: number;
  /** Target minus balance: positive means short by that much, negative means spare. */
  gapSgd: number;
  achievable: boolean;
}

export interface PlanMilestone {
  label: string;
  atAge: number;
}

export interface TeachingPoint {
  title: string;
  body: string;
}

export interface PlanJSON {
  goalSummary: string;
  verdict: PlanVerdict;
  /** Always exactly three actions. */
  actions: [string, string, string];
  requiredMonthlySavings: number;
  savingsSchedule: SavingsScheduleRow[];
  /** Present for property and car goals. */
  costStack?: CostStackRow[];
  /** Present for property goals. */
  debt?: DebtPlan;
  /** Nine cells: rate down, as-is, up by contribution down, as-is, up. */
  scenarioGrid: ScenarioCell[];
  milestones: PlanMilestone[];
  teaching: TeachingPoint[];
  assumptions: Assumption[];
}

/** Scenario deltas: one percentage point of rate and 20 percent of contribution. */
const SCENARIO_RATE_DELTAS: ReadonlyArray<number> = [-0.01, 0, 0.01];
const SCENARIO_CONTRIBUTION_DELTAS: ReadonlyArray<number> = [-0.2, 0, 0.2];
const MORTGAGE_TENOR_YEARS = 25;
const CAR_FLAT_RATE_PA = 0.027;

function assume(assumptions: Assumption[], field: string, fallback: number): number {
  const found = assumptions.find((entry) => entry.field === field);
  return found !== undefined && Number.isFinite(found.value) ? found.value : fallback;
}

function monthsToDeadline(profile: UserProfile, deadlineAge: number): number {
  return Math.max(1, Math.round((deadlineAge - profile.age) * 12));
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function trimZeros(text: string): string {
  return text.replace(/\.0$/, '');
}

/** Deterministic money formatting with no locale dependence. */
function fmtSgd(amount: number): string {
  const rounded = Math.round(amount);
  const negative = rounded < 0;
  const digits = Math.abs(rounded).toString();
  let grouped = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) {
      grouped += ',';
    }
    grouped += digits[index];
  }
  return `${negative ? '-' : ''}$${grouped}`;
}

function fmtRate(ratio: number): string {
  return `${trimZeros((ratio * 100).toFixed(1))} percent`;
}

function fmtYears(years: number): string {
  const rounded = Math.round(years * 10) / 10;
  if (rounded === 1) {
    return '1 year';
  }
  return `${trimZeros(rounded.toFixed(1))} years`;
}

interface SavingsCore {
  deadlineAge: number;
  months: number;
  ratePa: number;
  /** Cash the saver must accumulate by the deadline. */
  targetSgd: number;
  requiredMonthly: number;
  schedule: SavingsScheduleRow[];
}

function resolveDeadlineAge(
  goalDeadlineAge: number,
  profile: UserProfile,
  assumptions: Assumption[]
): number {
  if (Number.isFinite(goalDeadlineAge) && goalDeadlineAge > profile.age) {
    return goalDeadlineAge;
  }
  const assumed = assume(assumptions, 'deadlineAge', profile.age + 5);
  return assumed > profile.age ? assumed : profile.age + 5;
}

function resolveDeadlineYears(months: number): number {
  return Math.max(1, Math.round(months / 12));
}

/** Year rows built entirely from the fvLump and fvAnnuity kernels. */
function buildSavingsSchedule(
  pv: number,
  pmt: number,
  ratePa: number,
  months: number
): SavingsScheduleRow[] {
  const years = Math.max(1, Math.ceil(months / 12));
  const rows: SavingsScheduleRow[] = [];
  let previousBalance = 0;
  for (let year = 1; year <= years; year += 1) {
    const monthsElapsed = Math.min(year * 12, months);
    const balance = fvLump(pv, ratePa, monthsElapsed / 12) + fvAnnuity(pmt, ratePa, monthsElapsed);
    const contributions = pmt * (monthsElapsed - Math.min((year - 1) * 12, months));
    rows.push({
      year,
      contributions,
      interest: balance - previousBalance - contributions,
      balance,
    });
    previousBalance = balance;
  }
  return rows;
}

function savingsCore(
  pv: number,
  targetSgd: number,
  ratePa: number,
  profile: UserProfile,
  deadlineAge: number
): SavingsCore {
  const months = monthsToDeadline(profile, deadlineAge);
  const requiredMonthly = nonNegative(pmtForFv(targetSgd, pv, ratePa, months));
  return {
    deadlineAge,
    months,
    ratePa,
    targetSgd,
    requiredMonthly,
    schedule: buildSavingsSchedule(pv, requiredMonthly, ratePa, months),
  };
}

function verdictStatus(requiredMonthly: number, profile: UserProfile): VerdictStatus {
  const discretionary = profile.grossMonthlyIncome - profile.monthlyExpenses;
  if (requiredMonthly <= discretionary) {
    return 'achievable';
  }
  if (discretionary > 0 && requiredMonthly <= discretionary * 1.3) {
    return 'stretch';
  }
  return 'not_achievable';
}

function buildVerdict(
  status: VerdictStatus,
  core: SavingsCore,
  profile: UserProfile,
  extraReasons: ReadonlyArray<string>,
  goalNoun: string
): PlanVerdict {
  const discretionary = profile.grossMonthlyIncome - profile.monthlyExpenses;
  let headline: string;
  if (status === 'achievable') {
    headline =
      core.requiredMonthly <= 0
        ? `Achievable: your existing savings already cover the ${goalNoun} goal.`
        : `Achievable: ${fmtSgd(core.requiredMonthly)} a month fits inside your ${fmtSgd(discretionary)} monthly surplus.`;
  } else if (status === 'stretch') {
    headline = `Stretch: ${fmtSgd(core.requiredMonthly)} a month is within 30 percent above your ${fmtSgd(discretionary)} surplus.`;
  } else if (discretionary <= 0) {
    headline = `Not achievable yet: your expenses exceed your income and the ${goalNoun} goal needs ${fmtSgd(core.requiredMonthly)} a month.`;
  } else {
    headline = `Not achievable yet: ${fmtSgd(core.requiredMonthly)} a month is more than 130 percent of your ${fmtSgd(discretionary)} surplus.`;
  }
  const parts = [
    core.requiredMonthly <= 0
      ? 'Existing savings already reach the target so no new monthly saving is required.'
      : `Reaching the goal needs ${fmtSgd(core.requiredMonthly)} of saving every month against a disposable surplus of ${fmtSgd(discretionary)} (income minus expenses).`,
    ...extraReasons,
  ];
  return { status, headline, reasoning: parts.join(' ') };
}

function buildScenarioGrid(core: SavingsCore, pv: number): ScenarioCell[] {
  const cells: ScenarioCell[] = [];
  for (const rateDelta of SCENARIO_RATE_DELTAS) {
    const ratePa = core.ratePa + rateDelta;
    for (const contributionDelta of SCENARIO_CONTRIBUTION_DELTAS) {
      const monthlySgd = core.requiredMonthly * (1 + contributionDelta);
      const balanceSgd =
        fvLump(pv, ratePa, core.months / 12) + fvAnnuity(monthlySgd, ratePa, core.months);
      const gapSgd = core.targetSgd - balanceSgd;
      cells.push({
        rateDelta,
        contributionDelta,
        monthlySgd,
        balanceSgd,
        gapSgd,
        achievable: gapSgd <= 1e-6,
      });
    }
  }
  return cells;
}

function crossingAge(
  schedule: SavingsScheduleRow[],
  threshold: number,
  pv: number,
  currentAge: number
): number | null {
  if (pv >= threshold) {
    return currentAge;
  }
  for (const row of schedule) {
    if (row.balance >= threshold) {
      return currentAge + row.year;
    }
  }
  return null;
}

function buildTeaching(
  core: SavingsCore,
  pv: number,
  profile: UserProfile,
  assumptions: Assumption[],
  extras: { nominalTargetSgd: number; debt?: DebtPlan }
): TeachingPoint[] {
  const inflationPa = assume(assumptions, 'inflationPa', PLANNER_DEFAULTS.inflationPa);
  const years = core.months / 12;
  const contributionsTotal = core.schedule.reduce((sum, row) => sum + row.contributions, 0);
  const interestTotal = core.schedule.reduce((sum, row) => sum + row.interest, 0);
  const realTarget = realValue(extras.nominalTargetSgd, inflationPa, years);
  const cpfGrowthForegone = opportunityCostOfCpf(profile.cpfOaBalance, years);

  const points: TeachingPoint[] = [
    {
      title: 'Compounding works while you wait',
      body: `Over ${fmtYears(years)} the plan contributes ${fmtSgd(contributionsTotal)} and compounding at ${fmtRate(core.ratePa)} a year adds ${fmtSgd(interestTotal)} of interest on top. Time in the market is the one input you cannot top up later.`,
    },
    {
      title: 'Inflation shrinks real value',
      body: `At ${fmtRate(inflationPa)} inflation a year the ${fmtSgd(extras.nominalTargetSgd)} you need at the deadline spends like ${fmtSgd(realTarget)} in today money. Hitting the nominal number is not the same as keeping the buying power.`,
    },
    {
      title: 'CPF money carries an opportunity cost',
      body: `Cash left in the CPF OA keeps compounding at the 2.5 percent OA floor rate. Drawing the ${fmtSgd(profile.cpfOaBalance)} you hold today would give up roughly ${fmtSgd(cpfGrowthForegone)} of interest over ${fmtYears(years)}, so spend CPF dollars last.`,
    },
  ];

  if (extras.debt) {
    const installmentDelta =
      extras.debt.stress.monthlyInstallment - extras.debt.concessionary.monthlyInstallment;
    points.push({
      title: 'Rate sensitivity of the mortgage',
      body: `The installment moves from ${fmtSgd(extras.debt.concessionary.monthlyInstallment)} a month at ${fmtRate(extras.debt.concessionary.ratePa)} to ${fmtSgd(extras.debt.stress.monthlyInstallment)} at ${fmtRate(extras.debt.stress.ratePa)}, about ${fmtSgd(installmentDelta)} more every month. That gap is why the plan stress tests the loan.`,
    });
    points.push({
      title: 'What MSR and TDSR mean',
      body: `MSR caps the property installment at ${fmtRate(extras.debt.msr.limitRatio)} of gross income and TDSR caps all debt at ${fmtRate(extras.debt.tdsr.limitRatio)}. At your ${fmtSgd(profile.grossMonthlyIncome)} income the projected installment of ${fmtSgd(extras.debt.concessionary.monthlyInstallment)} is ${fmtRate(extras.debt.msr.ratio)} of income, so MSR ${extras.debt.msr.pass ? 'passes' : 'fails'} and TDSR ${extras.debt.tdsr.pass ? 'passes' : 'fails'}.`,
    });
  } else {
    const rateDown = nonNegative(
      pmtForFv(core.targetSgd, pv, Math.max(core.ratePa - 0.01, 0), core.months)
    );
    const rateUp = nonNegative(pmtForFv(core.targetSgd, pv, core.ratePa + 0.01, core.months));
    points.push({
      title: 'Rate sensitivity of your savings',
      body: `A savings rate 1 percentage point lower raises the required monthly saving to ${fmtSgd(rateDown)} while 1 point higher cuts it to ${fmtSgd(rateUp)} from the current ${fmtSgd(core.requiredMonthly)}. Small rate edges matter less than starting early.`,
    });
    const msrRatio = msrCheck(1, profile.grossMonthlyIncome).limitRatio;
    const tdsrRatio = tdsrCheck(1, profile.grossMonthlyIncome).limitRatio;
    points.push({
      title: 'What MSR and TDSR mean',
      body: `When you borrow for property later, MSR caps the installment at ${fmtRate(msrRatio)} of gross income and TDSR caps every debt payment at ${fmtRate(tdsrRatio)}. Your ${fmtSgd(profile.grossMonthlyIncome)} income supports up to ${fmtSgd(profile.grossMonthlyIncome * msrRatio)} under MSR and ${fmtSgd(profile.grossMonthlyIncome * tdsrRatio)} across all debt.`,
    });
  }
  return points;
}

function propertyLabel(propertyType: PropertyType): string {
  if (propertyType === 'bto') {
    return 'BTO flat';
  }
  if (propertyType === 'condo') {
    return 'private condominium';
  }
  return 'HDB resale flat';
}

function buildPropertyPlan(
  goal: PropertyPurchaseGoal,
  profile: UserProfile,
  assumptions: Assumption[]
): PlanJSON {
  const deadlineAge = resolveDeadlineAge(goal.deadlineAge, profile, assumptions);
  const ratePa = assume(assumptions, 'instrumentRatePa', PLANNER_DEFAULTS.instrumentRatePa);
  const price =
    goal.targetPriceSgd > 0
      ? goal.targetPriceSgd
      : assume(assumptions, 'targetPriceSgd', ILLUSTRATIVE_PROPERTY_PRICE_SGD[goal.propertyType]);

  // Upfront cost stack, every row from a property kernel or an assumption.
  const split = downPaymentSplit(price);
  const duty = bsd(price);
  const extraDuty = goal.firstProperty ? 0 : absd(price, { citizenship: 'citizen', propertyCount: 2 });
  const legal = legalFeesEstimate(price);
  const renovation =
    goal.propertyType === 'hdb_resale'
      ? assume(assumptions, 'renovationBufferSgd', PLANNER_DEFAULTS.renovationBufferSgd)
      : 0;
  const upfrontStack = split.total + duty + extraDuty + legal + renovation;

  // CPF OA reachability: does the balance, compounding at the kernel default
  // 2.5 percent, cover the CPF eligible leg of the down payment by the deadline?
  const months = monthsToDeadline(profile, deadlineAge);
  const oaRows = oaProjection(profile.cpfOaBalance, 0, resolveDeadlineYears(months));
  const oaAtDeadline = oaRows[oaRows.length - 1]?.balance ?? profile.cpfOaBalance;
  const cpfCoverable = Math.min(split.cpfPortion, oaAtDeadline);
  const cpfShortfall = split.cpfPortion - cpfCoverable;
  const cpfCoversLeg = cpfShortfall <= 0.01;
  const cashNeeded = Math.max(upfrontStack - cpfCoverable, 0);

  const core = savingsCore(profile.liquidSavings, cashNeeded, ratePa, profile, deadlineAge);

  const costStack: CostStackRow[] = [
    {
      label: 'Down payment: minimum cash',
      amountSgd: split.minCash,
      note: '5 percent of the price that must be paid in cash however large the CPF balance is.',
    },
    {
      label: 'Down payment: CPF coverable leg',
      amountSgd: split.cpfPortion,
      note: 'The rest of the 25 percent down payment that CPF OA savings may cover at the 75 percent LTV frame.',
    },
    {
      label: 'Buyer stamp duty (BSD)',
      amountSgd: duty,
      note: 'Marginal IRAS tier snapshot on the price. Illustrative and subject to statutory change.',
    },
  ];
  if (extraDuty > 0) {
    costStack.push({
      label: 'Additional buyer stamp duty (ABSD)',
      amountSgd: extraDuty,
      note: 'Singapore citizen second property snapshot rate of 20 percent. Rates depend on citizenship and property count.',
    });
  }
  costStack.push({
    label: 'Legal fees',
    amountSgd: legal,
    note: 'Conveyancing flat fee estimate for this price tier. Actual quotes vary.',
  });
  if (renovation > 0) {
    costStack.push({
      label: 'Renovation buffer',
      amountSgd: renovation,
      note: 'Illustrative resale renovation allowance carried as a buffer.',
    });
  }

  const loanPrincipal = Math.max(price - split.total, 0);
  const concessionaryRatePa = assume(
    assumptions,
    'hdbConcessionaryRatePa',
    PLANNER_DEFAULTS.hdbConcessionaryRatePa
  );
  const stressRatePa = assume(
    assumptions,
    'mortgageStressRatePa',
    PLANNER_DEFAULTS.mortgageStressRatePa
  );
  const concessionaryInstallment = amortize(
    loanPrincipal,
    concessionaryRatePa,
    MORTGAGE_TENOR_YEARS
  ).monthlyPayment;
  const stressInstallment = amortize(loanPrincipal, stressRatePa, MORTGAGE_TENOR_YEARS).monthlyPayment;
  const msr = msrCheck(concessionaryInstallment, profile.grossMonthlyIncome);
  const tdsr = tdsrCheck(concessionaryInstallment, profile.grossMonthlyIncome);
  const debt: DebtPlan = {
    loanPrincipalSgd: loanPrincipal,
    concessionary: {
      ratePa: concessionaryRatePa,
      tenorYears: MORTGAGE_TENOR_YEARS,
      monthlyInstallment: concessionaryInstallment,
    },
    stress: {
      ratePa: stressRatePa,
      tenorYears: MORTGAGE_TENOR_YEARS,
      monthlyInstallment: stressInstallment,
    },
    msr,
    tdsr,
  };

  const cpfLine = cpfCoversLeg
    ? `Your CPF OA balance is projected to reach ${fmtSgd(oaAtDeadline)} by age ${deadlineAge}, which covers the ${fmtSgd(split.cpfPortion)} CPF leg of the down payment.`
    : `Your CPF OA is projected to reach only ${fmtSgd(oaAtDeadline)} by age ${deadlineAge}, so the cash plan also covers the ${fmtSgd(cpfShortfall)} of the CPF leg it cannot fund.`;
  const msrLine =
    msr.pass && tdsr.pass
      ? `The projected installment of ${fmtSgd(concessionaryInstallment)} a month over ${MORTGAGE_TENOR_YEARS} years passes both MSR and TDSR at your income.`
      : `The projected installment of ${fmtSgd(concessionaryInstallment)} a month over ${MORTGAGE_TENOR_YEARS} years fails ${!msr.pass ? 'MSR' : ''}${!msr.pass && !tdsr.pass ? ' and ' : ''}${!tdsr.pass ? 'TDSR' : ''} at your income, so a bank may not grant the full loan.`;

  const status = verdictStatus(core.requiredMonthly, profile);
  const verdict = buildVerdict(status, core, profile, [cpfLine, msrLine], 'property');

  const firstAction =
    core.requiredMonthly > 0
      ? `Save ${fmtSgd(core.requiredMonthly)} a month at ${fmtRate(ratePa)} to reach ${fmtSgd(cashNeeded)} in cash by age ${deadlineAge}.`
      : `Your cash and CPF already cover the upfront stack. Keep the plan on autopilot and revisit before you exercise any option to purchase.`;
  const secondAction = cpfCoversLeg
    ? `Leave your CPF OA untouched so it compounds into the ${fmtSgd(split.cpfPortion)} down payment leg by the deadline.`
    : `Grow your CPF OA toward the ${fmtSgd(split.cpfPortion)} down payment leg through salary allocation or top ups. It is ${fmtSgd(cpfShortfall)} short of the leg today.`;
  const actions: [string, string, string] = [
    firstAction,
    secondAction,
    `Get a loan pre-approval and stress test it at ${fmtRate(stressRatePa)}: the installment would be ${fmtSgd(stressInstallment)} a month versus ${fmtSgd(concessionaryInstallment)} at ${fmtRate(concessionaryRatePa)}.`,
  ];

  const milestones: PlanMilestone[] = [];
  const cashMinAge = crossingAge(core.schedule, split.minCash, profile.liquidSavings, profile.age);
  if (cashMinAge !== null) {
    milestones.push({
      label: `Cash savings cover the 5 percent minimum cash down payment of ${fmtSgd(split.minCash)}`,
      atAge: cashMinAge,
    });
  }
  const stackAge = crossingAge(core.schedule, cashNeeded, profile.liquidSavings, profile.age);
  if (stackAge !== null) {
    milestones.push({
      label: `Cash savings cover the full upfront stack of ${fmtSgd(cashNeeded)}`,
      atAge: stackAge,
    });
  }
  milestones.push({
    label: `Buy the ${propertyLabel(goal.propertyType)} at ${fmtSgd(price)}`,
    atAge: deadlineAge,
  });

  return {
    goalSummary: `Buy a ${propertyLabel(goal.propertyType)} at ${fmtSgd(price)} by age ${deadlineAge}. The upfront cost stack is ${fmtSgd(upfrontStack)} of which ${fmtSgd(cashNeeded)} must come from cash savings after CPF.`,
    verdict,
    actions,
    requiredMonthlySavings: core.requiredMonthly,
    savingsSchedule: core.schedule,
    costStack,
    debt,
    scenarioGrid: buildScenarioGrid(core, profile.liquidSavings),
    milestones,
    teaching: buildTeaching(core, profile.liquidSavings, profile, assumptions, {
      nominalTargetSgd: upfrontStack,
      debt,
    }),
    assumptions,
  };
}

function buildCarPlan(goal: CarPurchaseGoal, profile: UserProfile, assumptions: Assumption[]): PlanJSON {
  const deadlineAge = resolveDeadlineAge(goal.deadlineAge, profile, assumptions);
  const ratePa = assume(assumptions, 'instrumentRatePa', PLANNER_DEFAULTS.instrumentRatePa);
  const price =
    goal.priceSgd > 0 ? goal.priceSgd : assume(assumptions, 'priceSgd', ILLUSTRATIVE_CAR_PRICE_SGD);
  const limits = carLoanLimits(price);
  const down = price * (1 - limits.ltv);
  const loan = price * limits.ltv;

  const core = savingsCore(profile.liquidSavings, down, ratePa, profile, deadlineAge);
  const status = verdictStatus(core.requiredMonthly, profile);
  const verdict = buildVerdict(
    status,
    core,
    profile,
    [
      `The ${fmtSgd(down)} down payment must come from cash because CPF cannot fund a car.`,
      `The remaining ${fmtSgd(loan)} would be financed at the ${fmtRate(limits.ltv)} loan-to-value cap for this value band.`,
    ],
    'car'
  );

  const costStack: CostStackRow[] = [
    {
      label: 'Down payment (cash)',
      amountSgd: down,
      note: `${fmtRate(1 - limits.ltv)} of the price, using the price as an open market value proxy for the illustrative ${fmtRate(limits.ltv)} loan cap.`,
    },
    {
      label: 'Car loan',
      amountSgd: loan,
      note: `Repayable over up to ${limits.maxTenorYears} years. Dealer flat rates cost far more than they look.`,
    },
  ];

  const actions: [string, string, string] = [
    core.requiredMonthly > 0
      ? `Save ${fmtSgd(core.requiredMonthly)} a month at ${fmtRate(ratePa)} to reach the ${fmtSgd(down)} down payment by age ${deadlineAge}.`
      : `Your existing savings already cover the ${fmtSgd(down)} down payment. Keep them liquid for the fees due at delivery.`,
    `Compare dealer flat rates with bank effective rates: a ${fmtRate(CAR_FLAT_RATE_PA)} flat rate over ${limits.maxTenorYears} years costs about ${fmtRate(flatToEffective(CAR_FLAT_RATE_PA, limits.maxTenorYears))} effective.`,
    `Budget insurance, road tax, fuel and servicing on top of the price before you commit. They usually rival the loan interest.`,
  ];

  const milestones: PlanMilestone[] = [];
  const halfwayAge = crossingAge(core.schedule, down / 2, profile.liquidSavings, profile.age);
  if (halfwayAge !== null) {
    milestones.push({
      label: `Halfway to the ${fmtSgd(down)} down payment`,
      atAge: halfwayAge,
    });
  }
  const downAge = crossingAge(core.schedule, down, profile.liquidSavings, profile.age);
  if (downAge !== null) {
    milestones.push({
      label: `Down payment of ${fmtSgd(down)} ready in cash`,
      atAge: downAge,
    });
  }
  milestones.push({ label: `Buy the car at ${fmtSgd(price)}`, atAge: deadlineAge });

  return {
    goalSummary: `Buy a car at ${fmtSgd(price)} by age ${deadlineAge} with a ${fmtSgd(down)} cash down payment at the ${fmtRate(limits.ltv)} loan-to-value cap.`,
    verdict,
    actions,
    requiredMonthlySavings: core.requiredMonthly,
    savingsSchedule: core.schedule,
    costStack,
    scenarioGrid: buildScenarioGrid(core, profile.liquidSavings),
    milestones,
    teaching: buildTeaching(core, profile.liquidSavings, profile, assumptions, {
      nominalTargetSgd: down,
    }),
    assumptions,
  };
}

function buildSavingsPlan(
  goal: SavingsTargetGoal,
  profile: UserProfile,
  assumptions: Assumption[]
): PlanJSON {
  const deadlineAge = resolveDeadlineAge(goal.deadlineAge, profile, assumptions);
  const ratePa = goal.instrumentRatePa ?? assume(assumptions, 'instrumentRatePa', PLANNER_DEFAULTS.instrumentRatePa);
  const target = Math.max(goal.targetAmountSgd, 0);
  const inflationPa = assume(assumptions, 'inflationPa', PLANNER_DEFAULTS.inflationPa);
  const realTarget = realValue(target, inflationPa, monthsToDeadline(profile, deadlineAge) / 12);

  const core = savingsCore(profile.liquidSavings, target, ratePa, profile, deadlineAge);
  const status = verdictStatus(core.requiredMonthly, profile);
  const verdict = buildVerdict(
    status,
    core,
    profile,
    [
      `At ${fmtRate(inflationPa)} inflation the ${fmtSgd(target)} will spend like about ${fmtSgd(realTarget)} in today money by the deadline.`,
    ],
    'savings'
  );

  const actions: [string, string, string] = [
    core.requiredMonthly > 0
      ? `Set up a standing order of ${fmtSgd(core.requiredMonthly)} a month into the instrument earning ${fmtRate(ratePa)}.`
      : `You already hold the target. Move it somewhere it keeps beating ${fmtRate(inflationPa)} inflation so it does not melt.`,
    `Automate the transfer the day your salary lands so the saving never competes with spending.`,
    `Review the rate every 6 months and move the cash if a comparable no lockup account beats ${fmtRate(ratePa)}.`,
  ];

  const milestones: PlanMilestone[] = [];
  const halfwayAge = crossingAge(core.schedule, target / 2, profile.liquidSavings, profile.age);
  if (halfwayAge !== null) {
    milestones.push({
      label: `Halfway there: cash passes ${fmtSgd(target / 2)}`,
      atAge: halfwayAge,
    });
  }
  const targetAge = crossingAge(core.schedule, target, profile.liquidSavings, profile.age);
  if (targetAge !== null) {
    milestones.push({
      label: `Target reached: cash passes ${fmtSgd(target)}`,
      atAge: targetAge,
    });
  }
  milestones.push({
    label: `Hold ${fmtSgd(target)} by age ${deadlineAge}`,
    atAge: deadlineAge,
  });

  return {
    goalSummary: `Save ${fmtSgd(target)} by age ${deadlineAge} with cash compounding at ${fmtRate(ratePa)} a year.`,
    verdict,
    actions,
    requiredMonthlySavings: core.requiredMonthly,
    savingsSchedule: core.schedule,
    scenarioGrid: buildScenarioGrid(core, profile.liquidSavings),
    milestones,
    teaching: buildTeaching(core, profile.liquidSavings, profile, assumptions, {
      nominalTargetSgd: target,
    }),
    assumptions,
  };
}

/** Entry point: any validated GoalSpec becomes a full plan. */
export function buildPlan(goal: GoalSpec, profile: UserProfile, assumptions: Assumption[]): PlanJSON {
  if (goal.kind === 'property_purchase') {
    return buildPropertyPlan(goal, profile, assumptions);
  }
  if (goal.kind === 'car_purchase') {
    return buildCarPlan(goal, profile, assumptions);
  }
  return buildSavingsPlan(goal, profile, assumptions);
}
