/**
 * Pure what-if engine: deterministic revision arithmetic plus the offline
 * fallback classifier for advisor messages.
 *
 * Nothing here reads the clock, throws dice or formats for a locale. Every
 * number the engine touches comes from the caller-supplied goal spec and
 * profile, and every output number is plain arithmetic on those inputs. The
 * note strings state exactly which approximation was made so the UI can show
 * it next to the recomputed plan.
 */
import type { GoalSpec, UserProfile } from '../planner/goalspec';
import type { AdvisorTurn, RevisionPatch } from './types';

/** What applyRevision hands back: the revised inputs plus a plain-word note. */
export interface RevisionResult {
  goalSpec: GoalSpec;
  profile: UserProfile;
  note: string;
}

/**
 * UserProfile today declares no debt field, but the runway burn honours one
 * when a caller carries it: a profile with monthlyDebtCommitments set burns
 * savings faster. The optional read keeps the frozen goalspec contract intact
 * while the arithmetic stays forward compatible.
 */
type ProfileWithOptionalDebt = UserProfile & { monthlyDebtCommitments?: number };

/** Deterministic money formatting with no locale dependence, whole dollars. */
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

/**
 * Applies a revision patch to a goal spec and profile, immutably.
 *
 * Numeric overrides replace only the field the goal kind actually carries:
 * targetPriceSgd edits property goals, priceSgd edits car goals and
 * targetAmountSgd edits savings goals; deadlineAge applies to every kind. A
 * field with no matching field on this goal kind is ignored and the note says
 * so. An incomeGap never touches the goal spec: it models a stretch without
 * income as burning runway deterministically, reducing liquidSavings by
 * months times (monthlyExpenses + (monthlyDebtCommitments ?? 0)) for the
 * affected person, or half that when who is 'both' at the combined level. The
 * note labels that plainly as an approximation because nothing else in the
 * plan math changes: income, expenses and rates are all held fixed.
 */
export function applyRevision(
  goalSpec: GoalSpec,
  profile: UserProfile,
  patch: RevisionPatch
): RevisionResult {
  const nextGoal: GoalSpec = { ...goalSpec };
  const nextProfile: UserProfile = { ...profile };
  const sentences: string[] = [];
  const ignored: string[] = [];

  if (patch.deadlineAge !== undefined) {
    const before = goalSpec.deadlineAge;
    nextGoal.deadlineAge = patch.deadlineAge;
    sentences.push(`Deadline moved from age ${before} to age ${patch.deadlineAge}.`);
  }

  if (patch.targetPriceSgd !== undefined) {
    if (nextGoal.kind === 'property_purchase') {
      sentences.push(
        `Target price moved from ${fmtSgd(goalSpec.kind === 'property_purchase' ? goalSpec.targetPriceSgd : 0)} to ${fmtSgd(patch.targetPriceSgd)}.`
      );
      nextGoal.targetPriceSgd = patch.targetPriceSgd;
    } else {
      ignored.push('targetPriceSgd');
    }
  }

  if (patch.priceSgd !== undefined) {
    if (nextGoal.kind === 'car_purchase') {
      sentences.push(
        `Price moved from ${fmtSgd(goalSpec.kind === 'car_purchase' ? goalSpec.priceSgd : 0)} to ${fmtSgd(patch.priceSgd)}.`
      );
      nextGoal.priceSgd = patch.priceSgd;
    } else {
      ignored.push('priceSgd');
    }
  }

  if (patch.targetAmountSgd !== undefined) {
    if (nextGoal.kind === 'savings_target') {
      sentences.push(
        `Target amount moved from ${fmtSgd(goalSpec.kind === 'savings_target' ? goalSpec.targetAmountSgd : 0)} to ${fmtSgd(patch.targetAmountSgd)}.`
      );
      nextGoal.targetAmountSgd = patch.targetAmountSgd;
    } else {
      ignored.push('targetAmountSgd');
    }
  }

  if (patch.incomeGap !== undefined) {
    const { months, who } = patch.incomeGap;
    const debt = (profile as ProfileWithOptionalDebt).monthlyDebtCommitments ?? 0;
    const monthlyBurn = profile.monthlyExpenses + debt;
    const burn = who === 'both' ? (months * monthlyBurn) / 2 : months * monthlyBurn;
    const before = profile.liquidSavings;
    nextProfile.liquidSavings = before - burn;
    const whoLabel = who === 'you' ? 'you' : who === 'partner' ? 'the partner' : 'both of you';
    const split =
      who === 'both'
        ? ' The burn is split half and half because the gap applies to both of you at the combined level.'
        : '';
    sentences.push(
      `Approximation: ${months} months without income for ${whoLabel} is modelled as burning runway, cutting liquid savings by ${fmtSgd(burn)} (${months} months at ${fmtSgd(monthlyBurn)} of monthly outgoings), from ${fmtSgd(before)} to ${fmtSgd(before - burn)}. Income, expenses and rates are held unchanged everywhere else.${split}`
    );
  }

  if (sentences.length === 0 && ignored.length === 0) {
    return { goalSpec: nextGoal, profile: nextProfile, note: 'No change applied: the patch was empty.' };
  }
  if (ignored.length > 0) {
    sentences.push(`Ignored ${ignored.join(', ')}: no matching field on a ${goalSpec.kind} goal.`);
  }
  return { goalSpec: nextGoal, profile: nextProfile, note: sentences.join(' ') };
}

/** Word numbers the offline classifier understands, one through twelve. */
const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

function parseCount(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  }
  return WORD_NUMBERS[raw] ?? null;
}

/** "six months", "6-month", "for 3 months" all yield their month count. */
const MONTHS_RE =
  /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[- ]?months?\b/;
/** "two years", "2-year", "by 3 years" all yield their year count. */
const YEARS_RE =
  /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[- ]?years?\b/;

/** Income loss phrasings: the words stop, quit, lose, no, take a break. */
const INCOME_LOSS_RE = /\b(?:stop|stops|stopping|quit|quits|quitting|lose|loses|losing|lost|no)\b|\btake a break\b/;
/** Employment words the loss phrase must sit near: work, job, income and cousins. */
const WORK_RE = /\b(?:work|works|working|worked|job|jobs|income|salary|paycheck|paycheque|employment)\b/;
/** Delay phrasings: later, delay, push back, postpone. */
const DELAY_RE =
  /\b(?:later|delay|delays|delayed|postpone|postponed|postponing)\b|\bpush\b[^.!?]*\bback\b/;
/** Cheaper goal phrasings. */
const CHEAPER_RE = /\b(?:cheaper|smaller|less expensive|lower price|downsize|downsizing)\b/;
/** Who the gap applies to; 'both' wins over 'partner' when both words appear. */
const BOTH_WHO_RE = /\b(?:both|both of us|we both|partner and i|i and (?:my )?partner)\b/;
const PARTNER_WHO_RE = /\b(?:partner|spouse|husband|wife|girlfriend|boyfriend|fiance|fiancee)\b/;

/** Splits a message into clause-strength segments so "near" means same segment. */
function segments(message: string): string[] {
  return message
    .toLowerCase()
    .split(/[.!?;\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** The canned guidance the offline parser returns when nothing matched. */
function offlineAnswer(): AdvisorTurn {
  return {
    kind: 'answer',
    summary:
      'This is the offline advisor parser, so it understands a fixed set of what-if shapes: a stretch without income ("what if I stop working for 6 months"), a delayed deadline ("what if I delay by 2 years" or "what if we push it back two years") and a cheaper goal ("what if I aim for a cheaper flat"). Rephrase the question in one of those shapes for a revised plan.',
  };
}

/**
 * Deterministic English classifier, the advisor's floor under the model.
 *
 * Priority order: an income-loss phrase (stop, quit, lose, no, take a break)
 * near a work, job or income word plus a number of months yields an incomeGap
 * patch; a delay phrase plus a number of years yields deadlineAge plus that
 * many years; "cheaper" or "smaller" yields the goal's price reduced by 10
 * percent; anything else is an answer turn carrying the canned guidance
 * above, honestly labelled as the offline parser.
 */
export function classifyFallback(message: string, goalSpec: GoalSpec): AdvisorTurn {
  const parts = segments(message);
  if (parts.length === 0) {
    return offlineAnswer();
  }

  // Income gap: loss phrase and employment word and month count in one segment.
  for (const part of parts) {
    if (!INCOME_LOSS_RE.test(part) || !WORK_RE.test(part)) {
      continue;
    }
    const match = MONTHS_RE.exec(part);
    const months = match?.[1] !== undefined ? parseCount(match[1]) : null;
    if (months !== null && months > 0) {
      const who: 'you' | 'partner' | 'both' = BOTH_WHO_RE.test(message)
        ? 'both'
        : PARTNER_WHO_RE.test(message)
          ? 'partner'
          : 'you';
      return {
        kind: 'revise',
        summary: `Treating ${months} months without income for ${who} as a runway burn on liquid savings.`,
        patch: { incomeGap: { months, who } },
      };
    }
  }

  // Delay: delay phrase and year count in one segment.
  for (const part of parts) {
    if (!DELAY_RE.test(part)) {
      continue;
    }
    const match = YEARS_RE.exec(part);
    const years = match?.[1] !== undefined ? parseCount(match[1]) : null;
    if (years !== null && years > 0) {
      const before = goalSpec.deadlineAge;
      return {
        kind: 'revise',
        summary: `Pushing the deadline back by ${years} years, from age ${before} to age ${before + years}.`,
        patch: { deadlineAge: before + years },
      };
    }
  }

  // Cheaper: the goal's own price field reduced by 10 percent.
  if (parts.some((part) => CHEAPER_RE.test(part))) {
    if (goalSpec.kind === 'property_purchase') {
      const cheaper = goalSpec.targetPriceSgd * 0.9;
      return {
        kind: 'revise',
        summary: `Trying a 10 percent cheaper property: from ${fmtSgd(goalSpec.targetPriceSgd)} to ${fmtSgd(cheaper)}.`,
        patch: { targetPriceSgd: cheaper },
      };
    }
    if (goalSpec.kind === 'car_purchase') {
      const cheaper = goalSpec.priceSgd * 0.9;
      return {
        kind: 'revise',
        summary: `Trying a 10 percent cheaper car: from ${fmtSgd(goalSpec.priceSgd)} to ${fmtSgd(cheaper)}.`,
        patch: { priceSgd: cheaper },
      };
    }
    const cheaper = goalSpec.targetAmountSgd * 0.9;
    return {
      kind: 'revise',
      summary: `Trying a 10 percent smaller target: from ${fmtSgd(goalSpec.targetAmountSgd)} to ${fmtSgd(cheaper)}.`,
      patch: { targetAmountSgd: cheaper },
    };
  }

  return offlineAnswer();
}
