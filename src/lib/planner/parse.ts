/**
 * Prompt to GoalSpec parsing.
 *
 * parseGoal tries Nemotron on Nebius Token Factory first and always falls back
 * to a deterministic regex parser, so the planner also works with no API key
 * and no network. Prompt stated values always win over values derived from
 * the profile: the profile only supplies context such as today's age when the
 * prompt says "in 5 years".
 */
import { chatJson, isConfigured, superModel } from '../nebius';
import {
  goalSpecSchema,
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

function systemPrompt(profileAge: number): string {
  return [
    'You are the goal parser of SpendWise, a Singapore financial goal planner.',
    'Reply with ONLY one JSON object and no other text. Choose exactly one shape:',
    '{"kind":"savings_target","targetAmountSgd":positive number,"deadlineAge":number,"instrumentRatePa":optional decimal rate where 1.8 percent pa is 0.018}',
    '{"kind":"property_purchase","propertyType":"hdb_resale" or "bto" or "condo","targetPriceSgd":positive number,"deadlineAge":number,"firstProperty":boolean}',
    '{"kind":"car_purchase","priceSgd":positive number,"deadlineAge":number}',
    'Rules:',
    `- deadlineAge is the age at which the user reaches the goal. The user is ${profileAge} now, so "in 5 years" means deadlineAge ${profileAge + 5}.`,
    '- Money is in SGD: 600k becomes 600000 and 1mil or 1m or 1 million becomes 1000000.',
    '- Rates are decimal fractions per annum.',
    '- Omit a field when the user never stated it instead of inventing a value. firstProperty defaults to true.',
    '- Never wrap the JSON in markdown fences and never add commentary.',
  ].join('\n');
}

function checkGoal(raw: unknown): { goal: GoalSpec | null; issues: string } {
  if (raw === null || typeof raw !== 'object') {
    return { goal: null, issues: 'the reply was not a JSON object' };
  }
  const result = goalSpecSchema.safeParse(raw);
  if (result.success) {
    return { goal: result.data, issues: '' };
  }
  const issues = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'root'}: ${issue.message}`)
    .join('; ');
  return { goal: null, issues };
}

/** One Nemotron call plus one corrective retry. Returns null when both fail. */
async function parseWithNemotron(prompt: string, profile: UserProfile): Promise<GoalSpec | null> {
  const system = systemPrompt(profile.age);
  const user = [
    `User profile: age ${profile.age}, gross monthly income ${profile.grossMonthlyIncome} SGD, monthly expenses ${profile.monthlyExpenses} SGD.`,
    `Goal request: ${prompt}`,
  ].join('\n');
  const first = await chatJson(system, user, superModel());
  const firstCheck = checkGoal(first);
  if (firstCheck.goal !== null) {
    return firstCheck.goal;
  }
  const retryUser = `${user}\n\nThat reply was not a valid GoalSpec: ${firstCheck.issues}. Reply again with ONLY one corrected JSON object.`;
  const second = await chatJson(system, retryUser, superModel());
  return checkGoal(second).goal;
}

/**
 * Parses the prompt into a GoalSpec. Uses Nemotron when Nebius is configured,
 * zod validates the reply with one corrective retry, and the deterministic
 * heuristic parser takes over whenever the LLM path fails or is unconfigured.
 */
export async function parseGoal(prompt: string, profile: UserProfile): Promise<GoalSpec | null> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return null;
  }
  if (isConfigured()) {
    const viaLlm = await parseWithNemotron(trimmed, profile);
    if (viaLlm !== null) {
      return viaLlm;
    }
  }
  return parseGoalFallback(trimmed, profile);
}

const PROPERTY_RE =
  /\b(hdb|resale|bto|build.to.order|condominium|condo|executive apartment|private property)\b/;
const CAR_RE = /\b(cars?|vehicles?|motorbike|motorcycle)\b/;
const SAVINGS_RE =
  /\b(save|saving|savings|accumulate|amass|set aside|nest egg)\b/;

function detectKind(text: string): GoalSpec['kind'] | null {
  if (PROPERTY_RE.test(text)) {
    return 'property_purchase';
  }
  if (CAR_RE.test(text)) {
    return 'car_purchase';
  }
  if (SAVINGS_RE.test(text)) {
    return 'savings_target';
  }
  return null;
}

function detectPropertyType(text: string): PropertyType {
  if (/\b(bto|build.to.order)\b/.test(text)) {
    return 'bto';
  }
  if (/\b(condo|condominium|private (?:property|apartment))\b/.test(text)) {
    return 'condo';
  }
  return 'hdb_resale';
}

function detectFirstProperty(text: string): boolean {
  if (/\bnot\s+(?:my\s+)?first\b/.test(text)) {
    return false;
  }
  return !/\b(second|third|2nd|3rd|another|next)\b/.test(text);
}

const DEADLINE_AGE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bby\s+age\s+(\d{1,2})\b/,
  /\bat\s+age\s+(\d{1,2})\b/,
  /\bby\s+(\d{1,2})\s+years?\s+old\b/,
  /\bwhen\s+i(?:'m|\s+am)\s+(\d{1,2})\b/,
];

function detectDeadlineAge(text: string, currentAge: number): number | null {
  for (const pattern of DEADLINE_AGE_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1] !== undefined) {
      const age = Number.parseInt(match[1], 10);
      if (Number.isFinite(age)) {
        return age;
      }
    }
  }
  const inYears = /\b(?:in|within)\s+(\d{1,2})\s+years?\b/.exec(text);
  if (inYears?.[1] !== undefined) {
    const span = Number.parseInt(inYears[1], 10);
    if (Number.isFinite(span)) {
      return currentAge + span;
    }
  }
  return null;
}

function detectRatePa(text: string): number | null {
  const percentPa =
    /(\d+(?:\.\d+)?)\s*(?:%|percent|per\s?cent)\s*(?:p\.?\s*a\.?|per\s+annum|per\s+year|annually)?/.exec(
      text
    );
  if (percentPa?.[1] !== undefined) {
    const rate = Number.parseFloat(percentPa[1]);
    if (Number.isFinite(rate)) {
      return rate / 100;
    }
  }
  const barePa = /(\d+(?:\.\d+)?)\s*p\.?\s*a\.?(?:\b|$)/.exec(text);
  if (barePa?.[1] !== undefined) {
    const rate = Number.parseFloat(barePa[1]);
    if (Number.isFinite(rate)) {
      return rate / 100;
    }
  }
  return null;
}

const SUFFIX_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  mil: 1_000_000,
  million: 1_000_000,
};

/**
 * Largest money amount in the text, in SGD. A match needs a k/m/mil/million
 * suffix, a $ / s$ / SGD prefix, or a bare number directly after a savings
 * verb ("save 30000") so phrases like "by age 28" never read as money.
 */
function largestMoneySgd(text: string): number | null {
  let largest: number | null = null;
  const consider = (value: number): void => {
    if (Number.isFinite(value) && (largest === null || value > largest)) {
      largest = value;
    }
  };
  const suffixed = /(\d[\d,]*(?:\.\d+)?)\s*(mil|million|m|k)(?![a-z0-9])/gi;
  for (const match of text.matchAll(suffixed)) {
    const amount = Number.parseFloat(match[1].replace(/,/g, ''));
    const multiplier = SUFFIX_MULTIPLIERS[match[2].toLowerCase()];
    if (multiplier !== undefined) {
      consider(amount * multiplier);
    }
  }
  const prefixed = /(?:\$|s\$|sgd)\s*(\d[\d,]*(?:\.\d+)?)(?:\s*(mil|million|m|k)(?![a-z0-9]))?/gi;
  for (const match of text.matchAll(prefixed)) {
    const amount = Number.parseFloat(match[1].replace(/,/g, ''));
    const suffix = match[2]?.toLowerCase();
    const multiplier = suffix !== undefined ? SUFFIX_MULTIPLIERS[suffix] ?? 1 : 1;
    consider(amount * multiplier);
  }
  // Bare amount right after a savings verb: "save 30000", "save up to 30,000",
  // "accumulate 25000". The lookahead keeps suffixed forms ("save 30k") for
  // the first pattern, and ages or years elsewhere never match because they
  // do not follow one of these verbs.
  const afterVerb =
    /(?:save|saving|saved|accumulate|set aside)(?:\s+up)?(?:\s+to)?\s+(\d[\d,]*(?:\.\d+)?)(?![a-z0-9])/gi;
  for (const match of text.matchAll(afterVerb)) {
    const amount = Number.parseFloat(match[1].replace(/,/g, ''));
    consider(amount);
  }
  return largest;
}

/**
 * Offline regex parser. Unstated numbers become the sentinel 0 (for amounts)
 * so missingFields reports them and fillAssumptions fills them; deadlineAge
 * 0 means "not stated".
 */
export function parseGoalFallback(prompt: string, profile: UserProfile): GoalSpec | null {
  const text = prompt.toLowerCase();
  const kind = detectKind(text);
  if (kind === null) {
    return null;
  }
  const deadlineAge = detectDeadlineAge(text, profile.age) ?? 0;
  if (kind === 'savings_target') {
    const goal: SavingsTargetGoal = {
      kind,
      targetAmountSgd: largestMoneySgd(text) ?? 0,
      deadlineAge,
      instrumentRatePa: detectRatePa(text) ?? undefined,
    };
    return goal;
  }
  if (kind === 'property_purchase') {
    const goal: PropertyPurchaseGoal = {
      kind,
      propertyType: detectPropertyType(text),
      targetPriceSgd: largestMoneySgd(text) ?? 0,
      deadlineAge,
      firstProperty: detectFirstProperty(text),
    };
    return goal;
  }
  const goal: CarPurchaseGoal = {
    kind,
    priceSgd: largestMoneySgd(text) ?? 0,
    deadlineAge,
  };
  return goal;
}

/**
 * Fields the plan still needs, as GoalSpec field names (plus investmentRatePa,
 * a profile field, when a portfolio exists but its growth rate is unstated).
 * A deadline at or before the current age counts as missing; the optional
 * instrumentRatePa is reported too because the plan needs a rate and an
 * assumption would fill it.
 */
export function missingFields(goal: GoalSpec, profile: UserProfile): string[] {
  const missing: string[] = [];
  const deadlineMissing = !Number.isFinite(goal.deadlineAge) || goal.deadlineAge <= profile.age;
  if ((profile.investmentsSgd ?? 0) > 0 && profile.investmentRatePa === undefined) {
    missing.push('investmentRatePa');
  }
  if (goal.kind === 'savings_target') {
    if (!(goal.targetAmountSgd > 0)) {
      missing.push('targetAmountSgd');
    }
    if (deadlineMissing) {
      missing.push('deadlineAge');
    }
    if (goal.instrumentRatePa === undefined) {
      missing.push('instrumentRatePa');
    }
  } else if (goal.kind === 'property_purchase') {
    if (!(goal.targetPriceSgd > 0)) {
      missing.push('targetPriceSgd');
    }
    if (deadlineMissing) {
      missing.push('deadlineAge');
    }
  } else {
    if (!(goal.priceSgd > 0)) {
      missing.push('priceSgd');
    }
    if (deadlineMissing) {
      missing.push('deadlineAge');
    }
  }
  return missing;
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

/**
 * Assumption entries for everything the prompt left unknown, so buildPlan can
 * always run. Beyond the five snapshot defaults it fills a missing deadline
 * (5 years from today) and missing prices (illustrative placeholders whose
 * reasons say so plainly).
 */
export function fillAssumptions(goal: GoalSpec, profile: UserProfile): Assumption[] {
  const assumptions: Assumption[] = [];
  const missing = new Set(missingFields(goal, profile));

  if (missing.has('deadlineAge')) {
    assumptions.push({
      field: 'deadlineAge',
      value: profile.age + 5,
      reason: 'No deadline was stated so the plan assumes 5 years from today.',
    });
  }

  if (missing.has('investmentRatePa')) {
    assumptions.push({
      field: 'investmentRatePa',
      value: PLANNER_DEFAULTS.investmentRatePa,
      reason: 'No investment growth rate was stated so the portfolio is assumed to grow at 4.5 percent a year.',
    });
  }

  if (goal.kind === 'savings_target') {
    if (missing.has('instrumentRatePa')) {
      assumptions.push({
        field: 'instrumentRatePa',
        value: PLANNER_DEFAULTS.instrumentRatePa,
        reason: 'No instrument rate was stated so cash grows at the default 1.8 percent a year.',
      });
    }
    assumptions.push({
      field: 'inflationPa',
      value: PLANNER_DEFAULTS.inflationPa,
      reason: 'Inflation is assumed at 2.5 percent a year for the real value teaching point.',
    });
    return assumptions;
  }

  if (goal.kind === 'property_purchase') {
    if (missing.has('targetPriceSgd')) {
      assumptions.push({
        field: 'targetPriceSgd',
        value: ILLUSTRATIVE_PROPERTY_PRICE_SGD[goal.propertyType],
        reason: `No price was stated so the plan uses an illustrative ${propertyLabel(goal.propertyType)} price. Verify it against current listings.`,
      });
    }
    assumptions.push({
      field: 'hdbConcessionaryRatePa',
      value: PLANNER_DEFAULTS.hdbConcessionaryRatePa,
      reason:
        goal.propertyType === 'condo'
          ? 'An illustrative financing floor of 2.6 percent a year sets the baseline installment. Private bank packages usually price above this.'
          : 'The HDB concessionary mortgage rate snapshot of 2.6 percent a year sets the baseline installment.',
    });
    assumptions.push({
      field: 'mortgageStressRatePa',
      value: PLANNER_DEFAULTS.mortgageStressRatePa,
      reason: 'The mortgage is stress tested at 4.0 percent a year to check the installment survives rate rises.',
    });
    if (goal.propertyType === 'hdb_resale') {
      assumptions.push({
        field: 'renovationBufferSgd',
        value: PLANNER_DEFAULTS.renovationBufferSgd,
        reason: 'Resale flats usually need work so the cost stack carries a 30000 renovation buffer.',
      });
    }
    assumptions.push({
      field: 'instrumentRatePa',
      value: PLANNER_DEFAULTS.instrumentRatePa,
      reason: 'Cash saved for the upfront cost grows at the default 1.8 percent a year because no instrument rate was stated.',
    });
    assumptions.push({
      field: 'inflationPa',
      value: PLANNER_DEFAULTS.inflationPa,
      reason: 'Inflation is assumed at 2.5 percent a year for the real value teaching point.',
    });
    return assumptions;
  }

  if (missing.has('priceSgd')) {
    assumptions.push({
      field: 'priceSgd',
      value: ILLUSTRATIVE_CAR_PRICE_SGD,
      reason: 'No price was stated so the plan uses an illustrative car price of 150000 SGD. Verify it against current listings.',
    });
  }
  assumptions.push({
    field: 'instrumentRatePa',
    value: PLANNER_DEFAULTS.instrumentRatePa,
    reason: 'Cash saved for the down payment grows at the default 1.8 percent a year because no instrument rate was stated.',
  });
  assumptions.push({
    field: 'inflationPa',
    value: PLANNER_DEFAULTS.inflationPa,
    reason: 'Inflation is assumed at 2.5 percent a year for the real value teaching point.',
  });
  return assumptions;
}
