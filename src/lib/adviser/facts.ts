/**
 * Fact sheets and model-prose rendering for the adviser.
 *
 * The model is only ever allowed to arrange words around figures the
 * deterministic ops already produced. buildFactSheet numbers those figures
 * into Fact values with deterministic formatting; renderModelProse replaces
 * [fact:ID] references with the formatted values and then gates every literal
 * money or percent claim in the result against the fact values, reusing
 * extractFigureClaims from the planner narrative with a 0.5 percent
 * tolerance. Any literal figure that does not match a fact is stripped from
 * the text and reported in rejected, so an invented number can never reach
 * the user. Pure throughout: no clock, no randomness, no locale formatting.
 */
import { extractFigureClaims } from '../planner/narrative';
import { formatSgd } from './ops';

/** How a fact value is rendered. Percent values are percentage points (25 means 25 percent). */
export type FactFormat = 'money' | 'percent' | 'age' | 'months' | 'count';

/** One fact before numbering: what it measures and how to show it. */
export interface FactSeed {
  /** Short human label, for example "Dining total for 2026-08". */
  label: string;
  /** The deterministic figure itself, straight from an ops function. */
  value: number;
  format: FactFormat;
}

/** One numbered fact. */
export interface Fact {
  /** Numbered id, "f1", "f2", ... in input order, for [fact:ID] references. */
  id: string;
  label: string;
  value: number;
  /** Deterministically formatted value; the only literal the model may copy for this fact. */
  formatted: string;
}

/** Relative tolerance for matching a literal claim to a fact value: 0.5 percent. */
export const FACT_TOLERANCE = 0.005;

function trimTrailingZeros(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/**
 * Deterministic per-format rendering. Ages and month counts round to whole
 * numbers so the formatted literal parses back to an allowed figure; money
 * uses the shared formatSgd; percent takes percentage points and appends a
 * percent sign.
 */
export function formatFactValue(value: number, format: FactFormat): string {
  if (!Number.isFinite(value)) {
    return 'not available';
  }
  switch (format) {
    case 'money':
      return formatSgd(value);
    case 'percent':
      return `${trimTrailingZeros(value.toFixed(2))}%`;
    case 'age':
      return `age ${Math.round(value)}`;
    case 'months':
      return `${Math.round(value)} months`;
    case 'count':
      return `${Math.round(value)}`;
  }
}

/**
 * Number fact seeds into a fact sheet.
 *
 * Formula: fact[i] = { id: `f${i + 1}`, label, value, formatted:
 * formatFactValue(value, format) }, preserving input order so ids are stable
 * and deterministic. No deduplication and no rounding of the stored value;
 * only the formatted literal is derived.
 */
export function buildFactSheet(entries: ReadonlyArray<FactSeed>): Fact[] {
  return entries.map((seed, index) => ({
    id: `f${index + 1}`,
    label: seed.label,
    value: seed.value,
    formatted: formatFactValue(seed.value, seed.format),
  }));
}

/**
 * Allowed numeric set for the figure gate: each fact's exact value plus its
 * rounded and two-decimal variants (mirroring the variants the planner
 * narrative allows) plus every figure claim embedded in its own formatted
 * literal, so a substituted fact can never fail its own gate.
 */
function allowedFactValues(facts: ReadonlyArray<Fact>): number[] {
  const values: number[] = [];
  for (const fact of facts) {
    values.push(fact.value, Math.round(fact.value), Number(fact.value.toFixed(2)));
    for (const claim of extractFigureClaims(fact.formatted)) {
      values.push(claim.value);
    }
  }
  return values;
}

function claimAllowed(claimValue: number, allowed: ReadonlyArray<number>): boolean {
  return allowed.some(
    (value) => Math.abs(claimValue - value) <= FACT_TOLERANCE * Math.max(Math.abs(value), 1)
  );
}

/** Result of rendering model prose: the text and every rejected literal. */
export interface RenderedProse {
  text: string;
  /** Every rejected literal: unknown [fact:ID] references and unmatched money or percent claims, in order of rejection. */
  rejected: string[];
}

/**
 * Render model prose against a fact sheet.
 *
 * Formula: first every [fact:ID] token is replaced by that fact's formatted
 * literal, or dropped and reported when the id is unknown. Then every money
 * and percent claim in the substituted text (extractFigureClaims, kinds
 * amount and percent; ages are not gated here because the ask gates money and
 * percent only) must match some fact value within FACT_TOLERANCE relative
 * with an absolute floor of one unit, exactly like the planner narrative
 * gate. A non-matching literal is stripped from the text and its raw form is
 * appended to rejected. The result therefore carries only figures the
 * deterministic facts produced.
 */
export function renderModelProse(prose: string, facts: ReadonlyArray<Fact>): RenderedProse {
  const rejected: string[] = [];
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  let text = prose.replace(/\[fact:([A-Za-z0-9_-]+)\]/g, (_whole, id: string) => {
    const fact = byId.get(id);
    if (fact === undefined) {
      rejected.push(`[fact:${id}] (no such fact)`);
      return '';
    }
    return fact.formatted;
  });
  const allowed = allowedFactValues(facts);
  for (const claim of extractFigureClaims(text)) {
    if (claim.kind !== 'amount' && claim.kind !== 'percent') {
      continue;
    }
    if (claimAllowed(claim.value, allowed)) {
      continue;
    }
    if (!rejected.includes(claim.raw)) {
      rejected.push(claim.raw);
    }
    text = text.split(claim.raw).join('');
  }
  return { text, rejected };
}
