/**
 * Budget limits for the adviser conversation.
 *
 * These constants cap what one adviser turn may send to the model and how
 * much history it may see, and buildAdviserContext enforces them
 * deterministically: history is trimmed to the newest MAX_HISTORY_MESSAGES
 * entries, then, only if the serialized payload still exceeds
 * MAX_PAYLOAD_BYTES, further oldest messages and finally expendable context
 * slices are dropped, with every drop named in the returned dropped list.
 * Nothing is ever dropped silently. Pure: no clock, no randomness, no locale
 * formatting.
 */
import type { AdvisorMessage } from '../advisor/types';
import type { AdviserContext } from './conversation';

/** Hard cap on the serialized adviser payload sent to the model, in bytes. */
export const MAX_PAYLOAD_BYTES = 32768;
/** History trim policy: keep at most this many newest messages. */
export const MAX_HISTORY_MESSAGES = 12;
/**
 * Conversation-level cap on model calls. classifyAdviserTurn uses at most two
 * per turn (one call plus one corrective retry); a conversation that tracks a
 * running counter should stop calling the model and stay on the deterministic
 * fallback once the counter reaches this limit.
 */
export const MAX_MODEL_CALLS_PER_CONVERSATION = 30;

/** Ledger months kept when the payload budget forces context trimming. */
const MAX_LEDGER_MONTHS_WHEN_TRIMMED = 6;
/** Goal summaries kept when the payload budget forces context trimming. */
const MAX_GOAL_SUMMARIES_WHEN_TRIMMED = 3;
/** Wallet names kept when the payload budget forces context trimming. */
const MAX_WALLET_NAMES_WHEN_TRIMMED = 6;

/**
 * UTF-8 byte length of a string, deterministically. TextEncoder is available
 * on every runtime the app ships (Node server and browser) and involves no
 * locale or clock dependence.
 */
export function byteSize(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The budgeted context plus an honest account of everything dropped. */
export interface AdviserContextBudget {
  /** The kept messages, oldest first, at most MAX_HISTORY_MESSAGES and possibly fewer after payload trimming. */
  messages: AdvisorMessage[];
  /** The context after any payload-driven trimming. */
  context: AdviserContext;
  /** UTF-8 bytes of JSON.stringify({ messages, context }) after trimming. */
  payloadBytes: number;
  /** What was dropped and why, in drop order; empty when nothing was dropped. */
  dropped: string[];
}

function measure(messages: ReadonlyArray<AdvisorMessage>, context: AdviserContext): number {
  return byteSize(JSON.stringify({ messages, context }));
}

/**
 * Enforce the conversation budgets.
 *
 * Formula: first trim history to the newest MAX_HISTORY_MESSAGES entries,
 * recording each dropped oldest message as `history message #N` (one-based
 * index in the original list). Then, while the serialized payload exceeds
 * MAX_PAYLOAD_BYTES and more than one message remains, drop the next oldest
 * message as `history message #N (payload budget)`. If the payload is still
 * over budget, trim context in a fixed order: keep only the newest
 * MAX_LEDGER_MONTHS_WHEN_TRIMMED ledger coverage months, then only the first
 * MAX_GOAL_SUMMARIES_WHEN_TRIMMED goal summaries, then only the first
 * MAX_WALLET_NAMES_WHEN_TRIMMED wallet names, recording each dropped slice.
 * The last message always survives every stage. If the payload is still over
 * budget after all of that, a final `payload still over budget by N bytes`
 * entry says so honestly instead of pretending to fit.
 */
export function buildAdviserContext(
  messages: ReadonlyArray<AdvisorMessage>,
  context: AdviserContext
): AdviserContextBudget {
  const dropped: string[] = [];
  let kept = messages.slice();
  const originalCount = kept.length;
  if (kept.length > MAX_HISTORY_MESSAGES) {
    const excess = kept.length - MAX_HISTORY_MESSAGES;
    for (let index = 0; index < excess; index += 1) {
      dropped.push(`history message #${index + 1}`);
    }
    kept = kept.slice(excess);
  }

  let trimmedContext: AdviserContext = context;
  let bytes = measure(kept, trimmedContext);
  while (bytes > MAX_PAYLOAD_BYTES && kept.length > 1) {
    const droppedIndex = originalCount - kept.length + 1;
    dropped.push(`history message #${droppedIndex} (payload budget)`);
    kept = kept.slice(1);
    bytes = measure(kept, trimmedContext);
  }

  if (bytes > MAX_PAYLOAD_BYTES) {
    const months = trimmedContext.ledgerAvailable.months
      .slice()
      .sort((a, b) => (a.monthKey < b.monthKey ? 1 : a.monthKey > b.monthKey ? -1 : 0))
      .slice(0, MAX_LEDGER_MONTHS_WHEN_TRIMMED)
      .sort((a, b) => (a.monthKey < b.monthKey ? -1 : a.monthKey > b.monthKey ? 1 : 0));
    for (const month of trimmedContext.ledgerAvailable.months) {
      if (!months.some((kept2) => kept2.monthKey === month.monthKey)) {
        dropped.push(`ledger month ${month.monthKey} (payload budget)`);
      }
    }
    trimmedContext = {
      ...trimmedContext,
      ledgerAvailable: { months },
    };
    bytes = measure(kept, trimmedContext);
  }

  if (bytes > MAX_PAYLOAD_BYTES && trimmedContext.goalSummaries.length > MAX_GOAL_SUMMARIES_WHEN_TRIMMED) {
    for (const goal of trimmedContext.goalSummaries.slice(MAX_GOAL_SUMMARIES_WHEN_TRIMMED)) {
      dropped.push(`goal summary ${goal.id} (payload budget)`);
    }
    trimmedContext = {
      ...trimmedContext,
      goalSummaries: trimmedContext.goalSummaries.slice(0, MAX_GOAL_SUMMARIES_WHEN_TRIMMED),
    };
    bytes = measure(kept, trimmedContext);
  }

  if (bytes > MAX_PAYLOAD_BYTES && trimmedContext.walletNames.length > MAX_WALLET_NAMES_WHEN_TRIMMED) {
    for (const name of trimmedContext.walletNames.slice(MAX_WALLET_NAMES_WHEN_TRIMMED)) {
      dropped.push(`wallet name ${name} (payload budget)`);
    }
    trimmedContext = {
      ...trimmedContext,
      walletNames: trimmedContext.walletNames.slice(0, MAX_WALLET_NAMES_WHEN_TRIMMED),
    };
    bytes = measure(kept, trimmedContext);
  }

  if (bytes > MAX_PAYLOAD_BYTES) {
    dropped.push(`payload still over budget by ${bytes - MAX_PAYLOAD_BYTES} bytes`);
  }

  return { messages: kept, context: trimmedContext, payloadBytes: bytes, dropped };
}
