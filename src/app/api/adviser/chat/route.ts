/**
 * POST /api/adviser/chat: the conversational spending adviser.
 *
 * Takes { messages, context, modelCallsUsed? } and answers one turn:
 *  - the raw body over the limits module's byte cap (MAX_PAYLOAD_BYTES) is
 *    refused with 413 before anything is parsed or executed;
 *  - a zod-mirrored body gets 400 with issues when it does not validate;
 *  - classifyAdviserTurn decides the operation (Nemotron when Nebius is
 *    configured and the conversation budget allows, the deterministic English
 *    classifier otherwise and on any failure);
 *  - the matched op is executed deterministically from the context data the
 *    client sent: the ledger rows and tracked goals in the request body, never
 *    any server-side storage. The route is stateless, so two identical
 *    requests always produce the identical reply;
 *  - the five-point explanation (data used, change proposed, monthly cash
 *    freed, effect on the selected goal, assumptions and missing information)
 *    is rendered from deterministic templates whose every figure comes from
 *    the pure ops layer;
 *  - when a key is configured and conversation budget remains, one optional
 *    model call may write prose around those figures; renderModelProse
 *    substitutes [fact:ID] tokens and strips any literal figure that does not
 *    match a deterministic fact, so an invented number can never reach the
 *    user. Prose failure leaves the deterministic explanation standing.
 *
 * The reply is { reply, points, op, engine, meta } where engine says which
 * classifier answered and meta carries the per-conversation model-call
 * accounting: modelCallsUsed is the client's counter plus the calls this turn
 * actually spent, and budgetRemaining is what is left of
 * MAX_MODEL_CALLS_PER_CONVERSATION. Repeated costly requests are guarded by
 * that budget: once it is exhausted the route pins itself to the deterministic
 * fallback and spends nothing. The API key never leaves the server; only the
 * engine word and the counters are returned.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { applyRevision } from '../../../../lib/advisor/engine';
import type { AdvisorMessage } from '../../../../lib/advisor/types';
import {
  classifyAdviserTurn,
  type AdviserContext,
  type AdviserModelFetcher,
  type AdviserTurnClassification,
} from '../../../../lib/adviser/conversation';
import {
  buildFactSheet,
  renderModelProse,
  type Fact,
  type FactSeed,
} from '../../../../lib/adviser/facts';
import {
  byteSize,
  MAX_MODEL_CALLS_PER_CONVERSATION,
  MAX_PAYLOAD_BYTES,
} from '../../../../lib/adviser/limits';
import {
  CATEGORY_LABELS,
  formatSgd,
  goalImpactWithExtra,
  monthComparison,
  oneOffImpact,
  reducibleCategories,
  spendingByCategory,
  type MonthSpendSummary,
  type ReduceProposal,
} from '../../../../lib/adviser/ops';
import { chatJson, isConfigured, superModel } from '../../../../lib/nebius';
import type { ExpenseCategory } from '../../../../lib/cards/types';
import type { GoalSpec, UserProfile } from '../../../../lib/planner/goalspec';
import { monthsToTarget, type TrackedGoal } from '../../../../lib/planner/progress';
import type { AdviserChatDetail, AdviserReduceProposalWire } from '../../../components/shared';

/* ---------------------------------------------------------------------- */
/* Request schemas: zod mirrors of the lib types the client posts          */
/* ---------------------------------------------------------------------- */

const MONTH_KEY_SCHEMA = z
  .string()
  .regex(/^\d{4}-\d{2}$/, 'month keys must look like "YYYY-MM", for example 2026-08');

const CATEGORY_VALUES = [
  'groceries',
  'dining',
  'online_shopping',
  'transport',
  'petrol',
  'travel',
  'utilities',
  'entertainment',
  'insurance',
  'education',
  'medical',
  'other',
] as const;

const categorySchema = z.enum(CATEGORY_VALUES);

const goalSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('savings_target'),
    targetAmountSgd: z.number(),
    deadlineAge: z.number(),
    instrumentRatePa: z.number().optional(),
  }),
  z.object({
    kind: z.literal('property_purchase'),
    propertyType: z.enum(['hdb_resale', 'bto', 'condo']),
    targetPriceSgd: z.number(),
    deadlineAge: z.number(),
    firstProperty: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('car_purchase'),
    priceSgd: z.number(),
    deadlineAge: z.number(),
  }),
]);

const profileSchema = z.object({
  age: z.number(),
  grossMonthlyIncome: z.number(),
  monthlyExpenses: z.number(),
  liquidSavings: z.number(),
  cpfOaBalance: z.number(),
  milesValuationCents: z.number().default(1.8),
  investmentsSgd: z.number().optional(),
  investmentRatePa: z.number().optional(),
  takeHomeMonthlyIncome: z.number().optional(),
  monthlyDebtCommitments: z.number().optional(),
  emergencyReserveMonths: z.number().optional(),
});

const ledgerEntrySchema = z.object({
  cardId: z.string().min(1),
  amountSgd: z.number(),
  category: categorySchema,
  monthKey: MONTH_KEY_SCHEMA,
});

const savingsLogSchema = z.object({
  monthKey: MONTH_KEY_SCHEMA,
  contributedSgd: z.number(),
  note: z.string().optional(),
  contributor: z.enum(['you', 'partner']).optional(),
});

const trackedGoalSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  goalSpec: goalSpecSchema,
  targetSgd: z.number(),
  requiredMonthlySgd: z.number(),
  ratePa: z.number(),
  startAge: z.number(),
  startSavingsSgd: z.number(),
  startInvestmentsSgd: z.number().optional(),
  investmentRatePa: z.number().optional(),
  deadlineAge: z.number(),
  startMonthKey: MONTH_KEY_SCHEMA,
  space: z.enum(['you', 'partner', 'us']).optional(),
  logs: z.array(savingsLogSchema),
});

const contextSchema = z.object({
  profile: profileSchema,
  walletNames: z.array(z.string()),
  /** Coverage summary the classifier reads; never the transactions. */
  ledgerAvailable: z.object({
    months: z.array(
      z.object({
        monthKey: MONTH_KEY_SCHEMA,
        recordCount: z.number().int().min(0),
      })
    ),
  }),
  goalSummaries: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      space: z.enum(['you', 'partner', 'us']).optional(),
      deadlineAge: z.number().optional(),
    })
  ),
  protectedCategories: z.array(categorySchema),
  /** Execution data: the ledger rows and tracked goals of the active space. */
  ledger: z.array(ledgerEntrySchema),
  goals: z.array(trackedGoalSchema),
  /** Which goal "effect on the selected goal" measures; defaults to the only goal. */
  selectedGoalId: z.string().min(1).optional(),
});

const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'advisor']),
        text: z.string({ invalid_type_error: 'each message text must be a string' }).min(1),
      })
    )
    .min(1, 'messages must hold at least one message'),
  context: contextSchema,
  /** Running per-conversation model-call counter the client keeps. */
  modelCallsUsed: z.number().int().min(0).optional(),
});

type ChatContext = z.infer<typeof contextSchema>;

/* ---------------------------------------------------------------------- */
/* Deterministic explanation templates                                     */
/* ---------------------------------------------------------------------- */

/** The five fixed point labels, in order. */
const POINT_LABELS = {
  dataUsed: 'Data used',
  change: 'Change proposed',
  freed: 'Monthly cash freed',
  goalEffect: 'Effect on the selected goal',
  assumptions: 'Assumptions and missing information',
} as const;

interface ExplanationPoint {
  label: string;
  body: string;
}

/** One executed op: the five rendered points, the fact seeds and any action. */
interface OpExecution {
  points: ExplanationPoint[];
  facts: FactSeed[];
  action?: { type: 'protect_category'; category: ExpenseCategory };
  /** Structured figures the client cards render beyond the five points. */
  detail?: AdviserChatDetail;
}

/** "3 months" / "1 month", deterministic. */
function monthsWords(months: number): string {
  return `${months} month${months === 1 ? '' : 's'}`;
}

/** A rate as a decimal becomes "1.8 percent", deterministic. */
function rateWords(ratePa: number): string {
  return `${Math.round(ratePa * 10000) / 10} percent`;
}

/** "Dining S$500 (2 records), Groceries S$550 (2 records)", sorted as computed. */
function recordsSentence(summary: MonthSpendSummary): string {
  const rows = summary.rows
    .map(
      (row) =>
        `${CATEGORY_LABELS[row.category]} ${formatSgd(row.total)} (${row.count} record${row.count === 1 ? '' : 's'})`
    )
    .join(', ');
  return `The ${summary.transactionCount} record${summary.transactionCount === 1 ? '' : 's'} you logged for ${summary.monthKey}${rows === '' ? '' : `: ${rows}`}.`;
}

/** The goal the effect point measures: the named one, else the only goal. */
function selectedGoal(context: ChatContext): TrackedGoal | null {
  if (context.selectedGoalId !== undefined) {
    return context.goals.find((goal) => goal.id === context.selectedGoalId) ?? null;
  }
  return context.goals.length === 1 ? (context.goals[0] as TrackedGoal) : null;
}

/** Deterministic one-line description of a goal spec. */
function describeGoalSpec(goal: GoalSpec): string {
  if (goal.kind === 'property_purchase') {
    return `buy a ${goal.propertyType === 'hdb_resale' ? 'HDB resale' : goal.propertyType === 'bto' ? 'BTO flat' : 'condo'} at ${formatSgd(goal.targetPriceSgd)} by age ${goal.deadlineAge}`;
  }
  if (goal.kind === 'car_purchase') {
    return `buy a car at ${formatSgd(goal.priceSgd)} by age ${goal.deadlineAge}`;
  }
  return `save ${formatSgd(goal.targetAmountSgd)} by age ${goal.deadlineAge}`;
}

function noGoalPoint(): ExplanationPoint {
  return {
    label: POINT_LABELS.goalEffect,
    body: 'No single tracked goal is selected in this space, so no goal effect was computed. Track exactly one goal or name the goal to see the effect measured.',
  };
}

function nothingFreedPoint(): ExplanationPoint {
  return { label: POINT_LABELS.freed, body: 'None: nothing was proposed.' };
}

function noEffectPoint(): ExplanationPoint {
  return { label: POINT_LABELS.goalEffect, body: 'None: nothing was proposed.' };
}

/** The honest five points for a turn whose month has no recorded data. */
function noRecordsExecution(note: string, ask: string): OpExecution {
  return {
    points: [
      { label: POINT_LABELS.dataUsed, body: `The ledger coverage summary for this space. ${note}` },
      {
        label: POINT_LABELS.change,
        body: `None: ${ask} needs months with logged records and the summary has none.`,
      },
      nothingFreedPoint(),
      noEffectPoint(),
      {
        label: POINT_LABELS.assumptions,
        body: 'The adviser reads only what you logged. A month with no records is unknown, not zero, so no figure was invented for it.',
      },
    ],
    facts: [],
  };
}

/** Effect of redirecting freed monthly cash into the selected goal. */
function goalEffectWithExtra(
  goal: TrackedGoal | null,
  freedMonthlySgd: number
): { point: ExplanationPoint; facts: FactSeed[] } {
  if (goal === null) {
    return { point: noGoalPoint(), facts: [] };
  }
  if (!(freedMonthlySgd > 0)) {
    return {
      point: {
        label: POINT_LABELS.goalEffect,
        body: `None yet: no monthly cash was freed, so ${goal.name} keeps its frozen pace of ${formatSgd(goal.requiredMonthlySgd)} a month.`,
      },
      facts: [],
    };
  }
  const impact = goalImpactWithExtra(goal, freedMonthlySgd);
  const facts: FactSeed[] = [];
  if (impact.monthsBefore !== null) {
    facts.push({ label: `Months to target at the frozen pace (${goal.name})`, value: impact.monthsBefore, format: 'months' });
  }
  if (impact.monthsAfter !== null) {
    facts.push({ label: `Months to target with the freed cash (${goal.name})`, value: impact.monthsAfter, format: 'months' });
  }
  if (impact.finishAgeBefore !== null) {
    facts.push({ label: `Finish age at the frozen pace (${goal.name})`, value: impact.finishAgeBefore, format: 'age' });
  }
  if (impact.finishAgeAfter !== null) {
    facts.push({ label: `Finish age with the freed cash (${goal.name})`, value: impact.finishAgeAfter, format: 'age' });
  }
  if (impact.monthsBefore === null || impact.monthsAfter === null) {
    return {
      point: {
        label: POINT_LABELS.goalEffect,
        body: `The frozen pace of ${goal.name} never reaches ${formatSgd(goal.targetSgd)} even with the freed ${formatSgd(freedMonthlySgd)} a month added, so the effect cannot be stated as a finish month.`,
      },
      facts,
    };
  }
  // Finish age at a non-null month count is the lib's own documented identity
  // (goalImpactWithExtra: finishAge = startAge + months / 12).
  const ageAt = (months: number): number => Math.round(goal.startAge + months / 12);
  const move =
    impact.monthsAfter === impact.monthsBefore
      ? `The finish does not move: ${monthsWords(impact.monthsBefore)} either way.`
      : `The finish moves from ${monthsWords(impact.monthsBefore)} (age ${ageAt(impact.monthsBefore)}) to ${monthsWords(impact.monthsAfter)} (age ${ageAt(impact.monthsAfter)}).`;
  return {
    point: {
      label: POINT_LABELS.goalEffect,
      body: `Redirecting the freed ${formatSgd(freedMonthlySgd)} a month into ${goal.name} re-solves the goal at its frozen rates: ${move}`,
    },
    facts,
  };
}

/** Names of the protected categories, for the assumptions point. */
function protectedSentence(categories: ReadonlyArray<ExpenseCategory>): string {
  if (categories.length === 0) {
    return 'No category is protected in this conversation yet.';
  }
  return `Protected categories excluded from every proposal: ${categories.map((entry) => CATEGORY_LABELS[entry]).join(', ')}.`;
}

function executeSpendingSummary(monthKey: string | null, context: ChatContext): OpExecution {
  if (monthKey === null) {
    return noRecordsExecution(
      'it carries no month with logged records',
      'a spending review'
    );
  }
  const summary = spendingByCategory(context.ledger, monthKey);
  return {
    points: [
      { label: POINT_LABELS.dataUsed, body: recordsSentence(summary) },
      {
        label: POINT_LABELS.change,
        body: 'None: a spending review is read-only. It changes no plan and moves no money.',
      },
      nothingFreedPoint(),
      noEffectPoint(),
      {
        label: POINT_LABELS.assumptions,
        body: `${summary.coverageNote} Categories count only what the ledger rows say, so a mis-tagged row mis-counts here.`,
      },
    ],
    facts: [
      ...summary.rows.map((row): FactSeed => ({
        label: `${CATEGORY_LABELS[row.category]} total for ${monthKey}`,
        value: row.total,
        format: 'money',
      })),
      { label: `Total logged for ${monthKey}`, value: summary.monthTotal, format: 'money' },
      { label: `Records logged for ${monthKey}`, value: summary.transactionCount, format: 'count' },
    ],
  };
}

function executeMonthCompare(
  monthKeyA: string,
  monthKeyB: string,
  context: ChatContext
): OpExecution {
  const result = monthComparison(context.ledger, monthKeyA, monthKeyB);
  if (!result.comparable) {
    return {
      points: [
        {
          label: POINT_LABELS.dataUsed,
          body: `Ledger coverage: ${monthKeyA} holds ${result.countA} record${result.countA === 1 ? '' : 's'} and ${monthKeyB} holds ${result.countB}.`,
        },
        {
          label: POINT_LABELS.change,
          body: 'None: the comparison refused to run on months with too little history.',
        },
        nothingFreedPoint(),
        noEffectPoint(),
        { label: POINT_LABELS.assumptions, body: result.reason },
      ],
      facts: [],
    };
  }
  const movers = result.rows
    .slice(0, 4)
    .map(
      (row) =>
        `${CATEGORY_LABELS[row.category]} ${row.delta >= 0 ? 'up' : 'down'} ${formatSgd(Math.abs(row.delta))}`
    )
    .join(', ');
  return {
    points: [
      {
        label: POINT_LABELS.dataUsed,
        body: `${result.transactionCountA} records for ${monthKeyA} (${formatSgd(result.totalA)}) against ${result.transactionCountB} records for ${monthKeyB} (${formatSgd(result.totalB)}). Largest movers: ${movers}. The later month logged ${formatSgd(Math.abs(result.totalDelta))} ${result.totalDelta >= 0 ? 'more' : 'less'} than the earlier one.`,
      },
      {
        label: POINT_LABELS.change,
        body: 'None: a month comparison is a measurement of what was logged, not a proposal.',
      },
      nothingFreedPoint(),
      noEffectPoint(),
      { label: POINT_LABELS.assumptions, body: result.caveat },
    ],
    facts: [
      { label: `Total logged for ${monthKeyA}`, value: result.totalA, format: 'money' },
      { label: `Total logged for ${monthKeyB}`, value: result.totalB, format: 'money' },
      { label: `Change between the months (${monthKeyA} to ${monthKeyB})`, value: result.totalDelta, format: 'money' },
      ...result.rows.slice(0, 4).map((row): FactSeed => ({
        label: `${CATEGORY_LABELS[row.category]} change between the months`,
        value: row.delta,
        format: 'money',
      })),
    ],
  };
}

function executeReduce(
  params: { monthKey: string | null; category?: ExpenseCategory; cutSgd?: number; freeSgd?: number },
  context: ChatContext
): OpExecution {
  if (params.monthKey === null) {
    return noRecordsExecution('it carries no month with logged records', 'a reduce proposal');
  }
  const monthKey = params.monthKey;
  const summary = spendingByCategory(context.ledger, monthKey);
  const reducible = reducibleCategories(context.ledger, monthKey, context.protectedCategories);
  const facts: FactSeed[] = [];
  let changeBody: string;
  let freedMonthly = 0;
  let capNote = '';
  const proposalWires: AdviserReduceProposalWire[] = [];
  let namedCategory: ExpenseCategory | undefined;

  if (params.category !== undefined && params.cutSgd !== undefined && params.cutSgd > 0) {
    const row = summary.rows.find((entry) => entry.category === params.category);
    if (row === undefined) {
      const logged = summary.rows.map((entry) => CATEGORY_LABELS[entry.category]).join(', ');
      return {
        points: [
          {
            label: POINT_LABELS.dataUsed,
            body: `${recordsSentence(summary)} The logged categories are ${logged === '' ? 'none' : logged}.`,
          },
          {
            label: POINT_LABELS.change,
            body: `No cut of ${CATEGORY_LABELS[params.category]} was sized: the records for ${monthKey} hold no ${CATEGORY_LABELS[params.category]} spending to trim.`,
          },
          nothingFreedPoint(),
          noEffectPoint(),
          {
            label: POINT_LABELS.assumptions,
            body: `${summary.coverageNote} A category with no logged records cannot be trimmed on evidence.`,
          },
        ],
        facts: [],
      };
    }
    const effective = Math.min(params.cutSgd, row.total);
    const sharePct = row.total > 0 ? Math.round((effective / row.total) * 100) : 0;
    changeBody =
      `Trim ${CATEGORY_LABELS[params.category]} by ${formatSgd(effective)} a month, about ${sharePct} percent of the ${formatSgd(row.total)} logged for ${monthKey}` +
      (effective < params.cutSgd
        ? `. The ${formatSgd(params.cutSgd)} you named exceeds the recorded total, so the cut is capped at what the records show.`
        : ', the figure you named.');
    freedMonthly = effective;
    namedCategory = params.category;
    proposalWires.push({
      category: params.category,
      monthTotal: row.total,
      proposedCut: effective,
      freedMonthly: effective,
    });
    facts.push(
      { label: `Proposed ${CATEGORY_LABELS[params.category]} cut per month`, value: effective, format: 'money' },
      { label: `${CATEGORY_LABELS[params.category]} total logged for ${monthKey}`, value: row.total, format: 'money' }
    );
  } else if (params.freeSgd !== undefined && params.freeSgd > 0) {
    const selected: ReduceProposal[] = [];
    let accumulated = 0;
    for (const proposal of reducible.proposals) {
      if (accumulated >= params.freeSgd) {
        break;
      }
      selected.push(proposal);
      accumulated += proposal.proposedCut;
    }
    if (selected.length === 0) {
      return {
        points: [
          { label: POINT_LABELS.dataUsed, body: recordsSentence(summary) },
          {
            label: POINT_LABELS.change,
            body: `Nothing was proposed: the non-protected categories logged for ${monthKey} hold no cut the caps can size.`,
          },
          nothingFreedPoint(),
          noEffectPoint(),
          {
            label: POINT_LABELS.assumptions,
            body: `${summary.coverageNote} ${protectedSentence(context.protectedCategories)}`,
          },
        ],
        facts: [],
      };
    }
    const list = selected
      .map((proposal) => `${CATEGORY_LABELS[proposal.category]} by ${formatSgd(proposal.proposedCut)}`)
      .join(', ');
    changeBody =
      `Free at least ${formatSgd(params.freeSgd)} a month by trimming ${list}.` +
      (accumulated < params.freeSgd
        ? ` The logged records only support freeing ${formatSgd(accumulated)}, short of the ${formatSgd(params.freeSgd)} asked.`
        : ` The whole proposals free ${formatSgd(accumulated)} because cuts land in S$10 steps.`);
    freedMonthly = accumulated;
    for (const proposal of selected) {
      proposalWires.push({
        category: proposal.category,
        monthTotal: proposal.monthTotal,
        proposedCut: proposal.proposedCut,
        freedMonthly: proposal.freedMonthly,
      });
    }
    for (const proposal of selected) {
      facts.push(
        { label: `Proposed ${CATEGORY_LABELS[proposal.category]} cut per month`, value: proposal.proposedCut, format: 'money' },
        { label: `${CATEGORY_LABELS[proposal.category]} total logged for ${monthKey}`, value: proposal.monthTotal, format: 'money' }
      );
    }
    capNote = `Engine proposals cap at ${Math.round(reducible.maxCutFraction * 100)} percent of each category's recorded month total and round down to a multiple of S$10.`;
  } else {
    const categoryFilter = params.category;
    const proposals =
      categoryFilter !== undefined
        ? reducible.proposals.filter((proposal) => proposal.category === categoryFilter)
        : reducible.proposals;
    if (proposals.length === 0) {
      return {
        points: [
          { label: POINT_LABELS.dataUsed, body: recordsSentence(summary) },
          {
            label: POINT_LABELS.change,
            body:
              categoryFilter !== undefined
                ? `No proposal for ${CATEGORY_LABELS[categoryFilter]}: it holds no trimmable records for ${monthKey}${context.protectedCategories.includes(categoryFilter) ? ' and it is protected' : ''}.`
                : `Nothing was proposed: the non-protected categories logged for ${monthKey} hold no cut the caps can size.`,
          },
          nothingFreedPoint(),
          noEffectPoint(),
          {
            label: POINT_LABELS.assumptions,
            body: `${summary.coverageNote} ${protectedSentence(context.protectedCategories)}`,
          },
        ],
        facts: [],
      };
    }
    const shown = proposals.slice(0, 4);
    const list = shown
      .map((proposal) => `${CATEGORY_LABELS[proposal.category]} by ${formatSgd(proposal.proposedCut)}`)
      .join(', ');
    changeBody = `Trim ${list}${proposals.length > shown.length ? `, and ${proposals.length - shown.length} smaller proposal${proposals.length - shown.length === 1 ? '' : 's'}` : ''}, freed gradually rather than all at once.`;
    freedMonthly = proposals.reduce((sum, proposal) => sum + proposal.proposedCut, 0);
    namedCategory = categoryFilter;
    for (const proposal of proposals) {
      proposalWires.push({
        category: proposal.category,
        monthTotal: proposal.monthTotal,
        proposedCut: proposal.proposedCut,
        freedMonthly: proposal.freedMonthly,
      });
    }
    for (const proposal of shown) {
      facts.push(
        { label: `Proposed ${CATEGORY_LABELS[proposal.category]} cut per month`, value: proposal.proposedCut, format: 'money' },
        { label: `${CATEGORY_LABELS[proposal.category]} total logged for ${monthKey}`, value: proposal.monthTotal, format: 'money' }
      );
    }
    capNote = `Engine proposals cap at ${Math.round(reducible.maxCutFraction * 100)} percent of each category's recorded month total and round down to a multiple of S$10.`;
  }

  facts.push({ label: 'Total monthly cash the proposals free', value: freedMonthly, format: 'money' });
  const goalEffect = goalEffectWithExtra(selectedGoal(context), freedMonthly);
  const reduceDetail: AdviserChatDetail = {
    kind: 'reduce',
    monthKey,
    freedMonthly,
    proposals: proposalWires,
    ...(namedCategory !== undefined ? { namedCategory } : {}),
  };
  return {
    points: [
      {
        label: POINT_LABELS.dataUsed,
        body: `${recordsSentence(summary)} Reducible pool outside protected categories: ${formatSgd(reducible.reducibleTotal)}.`,
      },
      { label: POINT_LABELS.change, body: changeBody },
      {
        label: POINT_LABELS.freed,
        body: freedMonthly > 0 ? `${formatSgd(freedMonthly)} a month, if the proposed cuts are actually made.` : 'None: nothing was proposed.',
      },
      goalEffect.point,
      {
        label: POINT_LABELS.assumptions,
        body: `${[summary.coverageNote, capNote, protectedSentence(context.protectedCategories)]
          .filter((part) => part !== '')
          .join(' ')}`,
      },
    ],
    facts: [...facts, ...goalEffect.facts],
    detail: reduceDetail,
  };
}

function executeOneOff(
  params: { amountSgd: number; goalId?: string },
  context: ChatContext
): OpExecution {
  const goal =
    params.goalId !== undefined
      ? (context.goals.find((entry) => entry.id === params.goalId) as TrackedGoal | undefined) ?? null
      : selectedGoal(context);
  if (goal === null) {
    return {
      points: [
        {
          label: POINT_LABELS.dataUsed,
          body: `The ${context.goals.length} tracked goal${context.goals.length === 1 ? '' : 's'} this space carries; the request did not settle on one.`,
        },
        {
          label: POINT_LABELS.change,
          body: `The one-off expense of ${formatSgd(params.amountSgd)} was heard, but no single goal was selected to measure it against.`,
        },
        nothingFreedPoint(),
        noGoalPoint(),
        {
          label: POINT_LABELS.assumptions,
          body: 'Name the goal (or keep exactly one tracked in this space) and ask again; the delay is computed only against one goal at a time.',
        },
      ],
      facts: [{ label: 'One-off expense heard', value: params.amountSgd, format: 'money' }],
    };
  }
  const impact = oneOffImpact(goal, params.amountSgd, context.goals);
  const potAfter = Math.max(0, goal.startSavingsSgd - params.amountSgd);
  const monthsBefore = monthsToTarget(
    goal.startSavingsSgd,
    goal.ratePa,
    goal.requiredMonthlySgd,
    goal.targetSgd
  );
  const monthsAfter = monthsToTarget(potAfter, goal.ratePa, goal.requiredMonthlySgd, goal.targetSgd);
  const effectBody =
    impact.monthsOfDelay === null
      ? `The frozen pace of ${goal.name} never reaches ${formatSgd(goal.targetSgd)}, so the delay cannot be stated in months.`
      : `The one-off pushes the target about ${monthsWords(impact.monthsOfDelay)} later at the goal's own frozen pace.`;
  const oneOffDetail: AdviserChatDetail = {
    kind: 'one_off',
    goalId: goal.id,
    goalName: goal.name,
    amountSgd: params.amountSgd,
    potBefore: goal.startSavingsSgd,
    potAfter,
    monthsBefore,
    monthsAfter,
    sharedPotWarning: impact.sharedPotWarning,
    goalsInSpaceCount: context.goals.length,
  };
  return {
    points: [
      {
        label: POINT_LABELS.dataUsed,
        body: `${goal.name} exactly as frozen at tracking: ${formatSgd(goal.startSavingsSgd)} starting savings, a required ${formatSgd(goal.requiredMonthlySgd)} a month at ${rateWords(goal.ratePa)}, target ${formatSgd(goal.targetSgd)} by age ${goal.deadlineAge}. The expense in question: ${formatSgd(params.amountSgd)}.`,
      },
      {
        label: POINT_LABELS.change,
        body: `Pay a one-off ${formatSgd(params.amountSgd)} out of the goal pot instead of from new money.`,
      },
      {
        label: POINT_LABELS.freed,
        body: 'None: a one-off expense consumes cash rather than freeing any.',
      },
      { label: POINT_LABELS.goalEffect, body: effectBody },
      { label: POINT_LABELS.assumptions, body: impact.note },
    ],
    facts: [
      { label: 'One-off expense', value: params.amountSgd, format: 'money' },
      { label: `${goal.name} starting savings (frozen)`, value: goal.startSavingsSgd, format: 'money' },
      { label: `${goal.name} required monthly (frozen)`, value: goal.requiredMonthlySgd, format: 'money' },
      { label: `${goal.name} target (frozen)`, value: goal.targetSgd, format: 'money' },
      ...(impact.monthsOfDelay === null
        ? []
        : [
            {
              label: `Months of delay to ${goal.name}`,
              value: impact.monthsOfDelay,
              format: 'months' as const,
            },
          ]),
    ],
    detail: oneOffDetail,
  };
}

function executeWhatIf(
  params: { patch: { deadlineAge?: number; targetPriceSgd?: number; priceSgd?: number; targetAmountSgd?: number; incomeGap?: { months: number; who: 'you' | 'partner' | 'both' } } },
  context: ChatContext
): OpExecution {
  const goal = selectedGoal(context);
  const profile = context.profile as UserProfile;
  if (goal === null) {
    return {
      points: [
        {
          label: POINT_LABELS.dataUsed,
          body: `The profile you sent: gross ${formatSgd(profile.grossMonthlyIncome)} a month, expenses ${formatSgd(profile.monthlyExpenses)} a month, liquid savings ${formatSgd(profile.liquidSavings)}. No tracked goal settles the what-if.`,
        },
        {
          label: POINT_LABELS.change,
          body: 'The revision was heard, but no single goal was selected to apply it to.',
        },
        nothingFreedPoint(),
        noGoalPoint(),
        {
          label: POINT_LABELS.assumptions,
          body: 'Track exactly one goal in this space or name the goal, then ask again.',
        },
      ],
      facts: [],
    };
  }
  const revision = applyRevision(goal.goalSpec, profile, params.patch);
  const savingsMoved = revision.profile.liquidSavings !== profile.liquidSavings;
  const patchKind: 'deadlineAge' | 'incomeGap' | 'price' =
    params.patch.incomeGap !== undefined
      ? 'incomeGap'
      : params.patch.deadlineAge !== undefined
        ? 'deadlineAge'
        : 'price';
  const whatIfDetail: AdviserChatDetail = {
    kind: 'what_if',
    goalId: goal.id,
    goalName: goal.name,
    revisedGoalSpec: revision.goalSpec,
    revisedProfile: revision.profile,
    savingsBefore: profile.liquidSavings,
    savingsAfter: revision.profile.liquidSavings,
    patchKind,
  };
  return {
    points: [
      {
        label: POINT_LABELS.dataUsed,
        body: `${goal.name} (${describeGoalSpec(goal.goalSpec)}) and the profile you sent: gross ${formatSgd(profile.grossMonthlyIncome)} a month, expenses ${formatSgd(profile.monthlyExpenses)} a month, liquid savings ${formatSgd(profile.liquidSavings)}.`,
      },
      { label: POINT_LABELS.change, body: revision.note },
      {
        label: POINT_LABELS.freed,
        body: 'None: a what-if revises plan inputs; it frees no monthly cash.',
      },
      {
        label: POINT_LABELS.goalEffect,
        body: `The revision re-plans ${goal.name} as ${describeGoalSpec(revision.goalSpec)}${savingsMoved ? `, with liquid savings modelled at ${formatSgd(revision.profile.liquidSavings)} after the burn` : ''}.`,
      },
      {
        label: POINT_LABELS.assumptions,
        body: 'Income, expenses and rates are held unchanged except where the note says otherwise. The runway burn is an approximation, not a forecast.',
      },
    ],
    facts: [
      { label: 'Gross monthly income', value: profile.grossMonthlyIncome, format: 'money' },
      { label: 'Monthly expenses', value: profile.monthlyExpenses, format: 'money' },
      { label: 'Liquid savings after the revision', value: revision.profile.liquidSavings, format: 'money' },
    ],
    detail: whatIfDetail,
  };
}

function executeProtectCategory(category: ExpenseCategory, context: ChatContext): OpExecution {
  return {
    points: [
      {
        label: POINT_LABELS.dataUsed,
        body: `The protected categories this conversation arrived with: ${
          context.protectedCategories.length === 0
            ? 'none yet'
            : context.protectedCategories.map((entry) => CATEGORY_LABELS[entry]).join(', ')
        }.`,
      },
      {
        label: POINT_LABELS.change,
        body: `Protect ${CATEGORY_LABELS[category]}: every reduce proposal from this turn on excludes it.`,
      },
      {
        label: POINT_LABELS.freed,
        body: 'None: protecting a category changes no spending by itself.',
      },
      {
        label: POINT_LABELS.goalEffect,
        body: 'None directly; protection only narrows where future cuts may land.',
      },
      {
        label: POINT_LABELS.assumptions,
        body: 'Protection lives in the context your client sends; store it there to keep it across turns. The category keeps its logged records.',
      },
    ],
    facts: [],
    action: { type: 'protect_category', category },
  };
}

/** Dispatch a classified turn (clarify and unsupported already handled). */
function executeTurn(
  turn: Exclude<AdviserTurnClassification, { op: 'clarify' } | { op: 'unsupported' }>,
  context: ChatContext
): OpExecution {
  switch (turn.op) {
    case 'spending_summary':
      return executeSpendingSummary(turn.params.monthKey, context);
    case 'month_compare':
      return executeMonthCompare(turn.params.monthKeyA, turn.params.monthKeyB, context);
    case 'reduce':
      return executeReduce(turn.params, context);
    case 'one_off':
      return executeOneOff(turn.params, context);
    case 'what_if':
      return executeWhatIf({ patch: turn.params.patch }, context);
    case 'protect_category':
      return executeProtectCategory(turn.params.category, context);
  }
}

/* ---------------------------------------------------------------------- */
/* Optional model prose, gated through the fact sheet                     */
/* ---------------------------------------------------------------------- */

const proseReplySchema = z.object({ prose: z.string().min(1) });

function proseSystemPrompt(): string {
  return [
    'You are the wording layer of the SpendWise adviser for Singapore savers.',
    'Deterministic engines already computed every figure and wrote the explanation you are given.',
    'Write one short paragraph, at most 90 words, plain and warm, no markdown, no lists, no emoji and no new advice.',
    'You must not write any dollar amount, percentage or age yourself: reference a figure only through its token, for example [fact:f1], and the renderer replaces tokens with the exact deterministic figures.',
    'Any literal figure that does not match a fact is stripped from your text.',
    'Reply with ONLY the JSON object {"prose":"..."}.',
  ].join('\n');
}

function proseUserPayload(points: ExplanationPoint[], facts: ReadonlyArray<Fact>): string {
  const lines = points.map((point) => `${point.label}: ${point.body}`);
  const factLines = facts.map((fact) => `${fact.id}: ${fact.label} = ${fact.formatted}`);
  return [
    'Deterministic explanation:',
    ...lines,
    'Facts you may reference (tokens only, never write the figures yourself):',
    ...factLines,
    'Write the prose.',
  ].join('\n');
}

/* ---------------------------------------------------------------------- */
/* The route                                                               */
/* ---------------------------------------------------------------------- */

function badRequest(error: string, issues?: string[]): Response {
  return NextResponse.json({ error, issues: issues ?? [] }, { status: 400 });
}

export async function POST(request: Request): Promise<Response> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return badRequest('Request body must be JSON shaped like { "messages": AdvisorMessage[], "context": AdviserContext }.');
  }
  if (byteSize(raw) > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `Payload too large: the adviser request body is ${byteSize(raw)} bytes and the cap is ${MAX_PAYLOAD_BYTES}. Trim the conversation history or the context and send again.`,
      },
      { status: 413 }
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest(
      'Request body must be JSON shaped like { "messages": AdvisorMessage[], "context": AdviserContext }.'
    );
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(
      'Invalid request body. Expected { "messages": [{ "role": "user" or "advisor", "text": non-empty string }], "context": { profile, walletNames, ledgerAvailable, goalSummaries, protectedCategories, ledger, goals, selectedGoalId? }, "modelCallsUsed": whole number }.',
      parsed.error.issues.map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'body'}: ${issue.message}`
      )
    );
  }

  const { messages, context } = parsed.data;
  const usedBefore =
    parsed.data.modelCallsUsed !== undefined
      ? Math.min(parsed.data.modelCallsUsed, MAX_MODEL_CALLS_PER_CONVERSATION)
      : 0;

  // Counting fetcher: every real chatJson call this turn spends is recorded,
  // so the client's running counter stays truthful. When the conversation
  // budget is already spent the stub returns null without touching the
  // network, pinning the turn to the deterministic fallback at zero cost.
  let modelCalls = 0;
  const budgetExhausted = usedBefore >= MAX_MODEL_CALLS_PER_CONVERSATION;
  const countingFetcher: AdviserModelFetcher = budgetExhausted
    ? async () => null
    : (system, user, model) => {
        modelCalls += 1;
        return chatJson(system, user, model);
      };

  try {
    const classifyContext: AdviserContext = {
      profile: context.profile,
      walletNames: context.walletNames,
      ledgerAvailable: context.ledgerAvailable,
      goalSummaries: context.goalSummaries,
      protectedCategories: context.protectedCategories,
    };
    const turn = await classifyAdviserTurn(
      messages as ReadonlyArray<AdvisorMessage>,
      classifyContext,
      countingFetcher
    );

    if (turn.op === 'clarify' || turn.op === 'unsupported') {
      return NextResponse.json({
        reply: turn.op === 'clarify' ? turn.params.question : turn.params.message,
        points: [],
        op: turn.op,
        engine: turn.engine,
        meta: {
          modelCallsUsed: usedBefore + modelCalls,
          budgetRemaining: Math.max(0, MAX_MODEL_CALLS_PER_CONVERSATION - (usedBefore + modelCalls)),
        },
      });
    }

    const execution = executeTurn(turn, context);

    // Optional model prose: one more call, only when a key is configured,
    // budget remains and the turn produced facts to write around. The gate in
    // renderModelProse strips every literal figure that is not a fact.
    let prose: string | null = null;
    if (
      execution.facts.length > 0 &&
      isConfigured() &&
      usedBefore + modelCalls < MAX_MODEL_CALLS_PER_CONVERSATION
    ) {
      modelCalls += 1;
      const factSheet = buildFactSheet(execution.facts);
      const reply = await chatJson(
        proseSystemPrompt(),
        proseUserPayload(execution.points, factSheet),
        superModel()
      );
      const proseParsed = proseReplySchema.safeParse(reply);
      if (proseParsed.success) {
        const rendered = renderModelProse(proseParsed.data.prose, factSheet);
        const text = rendered.text.trim();
        if (text !== '') {
          prose = text;
        }
      }
    }

    const lines = execution.points.map((point) => `${point.label}: ${point.body}`);
    const reply =
      prose === null ? lines.join('\n') : `${lines.join('\n')}\nIn the adviser's words: ${prose}`;
    return NextResponse.json({
      reply,
      points: execution.points,
      ...(execution.action !== undefined ? { action: execution.action } : {}),
      ...(execution.detail !== undefined ? { detail: execution.detail } : {}),
      op: turn.op,
      engine: turn.engine,
      meta: {
        modelCallsUsed: usedBefore + modelCalls,
        budgetRemaining: Math.max(0, MAX_MODEL_CALLS_PER_CONVERSATION - (usedBefore + modelCalls)),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: `Adviser chat failed: ${error instanceof Error ? error.message : 'unknown error'}.` },
      { status: 500 }
    );
  }
}
