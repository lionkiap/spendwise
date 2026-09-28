'use client';

/**
 * Add-your-own-card form and the saved custom card list.
 *
 * Validation is entirely delegated to parseCustomCard: the form converts its
 * strings into the decimal units the schema speaks (cashback percentages are
 * divided by 100, miles rates stay in mpd), calls the lib and renders the
 * returned errors inline. Nothing is saved until the lib accepts it, so
 * localStorage only ever holds drafts that already validated.
 */
import { useState } from 'react';

import { MAX_CUSTOM_TIERS, parseCustomCard } from '../../lib/cards/custom';
import type { ExpenseCategory } from '../../lib/cards/types';
import {
  CATEGORIES,
  fmtMoney,
  fmtPct,
  type CustomCardStored,
} from './shared';

interface TierRowState {
  category: ExpenseCategory;
  rate: string;
  cap: string;
}

interface CustomFormState {
  name: string;
  issuer: string;
  rewardType: 'cashback' | 'miles';
  baseRate: string;
  tiers: TierRowState[];
  minSpend: string;
  milesPerDollar: string;
  annualFee: string;
}

interface CustomCardManagerProps {
  stored: CustomCardStored[];
  onSave: (draft: CustomCardStored, editingIndex: number | null) => void;
  onDelete: (index: number) => void;
}

/** Empty string stays empty; anything unparseable becomes NaN so zod rejects it. */
function strictNumber(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return Number.NaN;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function optionalStrictNumber(raw: string): number | undefined {
  return raw.trim() === '' ? undefined : strictNumber(raw);
}

function blankForm(): CustomFormState {
  return {
    name: '',
    issuer: '',
    rewardType: 'cashback',
    baseRate: '',
    tiers: [],
    minSpend: '',
    milesPerDollar: '',
    annualFee: '0',
  };
}

function formFromStored(draft: CustomCardStored): CustomFormState {
  return {
    name: draft.name,
    issuer: draft.issuer,
    rewardType: draft.rewardType,
    baseRate:
      draft.rewardType === 'cashback' ? String(draft.baseRate * 100) : String(draft.baseRate),
    tiers: draft.earnStructure.map((tier) => ({
      category: tier.category,
      rate: draft.rewardType === 'cashback' ? String(tier.rate * 100) : String(tier.rate),
      cap: tier.capMonthlySgd !== undefined ? String(tier.capMonthlySgd) : '',
    })),
    minSpend: draft.minMonthlySpendSgd !== undefined ? String(draft.minMonthlySpendSgd) : '',
    milesPerDollar: draft.milesPerDollar !== undefined ? String(draft.milesPerDollar) : '',
    annualFee: String(draft.annualFeeSgd),
  };
}

export function CustomCardManager({ stored, onSave, onDelete }: CustomCardManagerProps) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CustomFormState>(blankForm);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const miles = form.rewardType === 'miles';
  const rateLabel = miles ? 'Rate (mpd)' : 'Rate (%)';

  function rateToUnits(raw: string): number {
    const value = strictNumber(raw);
    return miles ? value : value / 100;
  }

  function updateTier(index: number, patch: Partial<TierRowState>): void {
    setForm((previous) => ({
      ...previous,
      tiers: previous.tiers.map((tier, tierIndex) =>
        tierIndex === index ? { ...tier, ...patch } : tier
      ),
    }));
  }

  function addTier(): void {
    setForm((previous) =>
      previous.tiers.length >= MAX_CUSTOM_TIERS
        ? previous
        : { ...previous, tiers: [...previous.tiers, { category: 'dining', rate: '', cap: '' }] }
    );
  }

  function removeTier(index: number): void {
    setForm((previous) => ({
      ...previous,
      tiers: previous.tiers.filter((_, tierIndex) => tierIndex !== index),
    }));
  }

  function startEdit(index: number): void {
    const draft = stored[index];
    if (draft === undefined) {
      return;
    }
    setForm(formFromStored(draft));
    setEditingIndex(index);
    setErrors([]);
    setOpen(true);
  }

  function resetForm(): void {
    setForm(blankForm());
    setEditingIndex(null);
    setErrors([]);
  }

  function handleSave(): void {
    const input = {
      name: form.name,
      issuer: form.issuer.trim() === '' ? undefined : form.issuer.trim(),
      rewardType: form.rewardType,
      baseRate: rateToUnits(form.baseRate),
      earnStructure: form.tiers.map((tier) => ({
        category: tier.category,
        rate: rateToUnits(tier.rate),
        ...(tier.cap.trim() !== ''
          ? { capMonthlySgd: strictNumber(tier.cap) }
          : {}),
      })),
      ...(form.minSpend.trim() !== ''
        ? { minMonthlySpendSgd: strictNumber(form.minSpend) }
        : {}),
      ...(miles && form.milesPerDollar.trim() !== ''
        ? { milesPerDollar: strictNumber(form.milesPerDollar) }
        : {}),
      annualFeeSgd: strictNumber(form.annualFee),
    };

    const parsed = parseCustomCard(input);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }

    const card = parsed.card;
    const draft: CustomCardStored = {
      name: card.name,
      issuer: card.issuer,
      rewardType: card.rewardType,
      baseRate: card.baseRate,
      earnStructure: card.earnStructure.map((tier) => ({
        category: tier.category,
        rate: tier.rate,
        ...(tier.capMonthlySgd !== undefined ? { capMonthlySgd: tier.capMonthlySgd } : {}),
      })),
      ...(card.minMonthlySpendSgd !== undefined
        ? { minMonthlySpendSgd: card.minMonthlySpendSgd }
        : {}),
      ...(card.milesPerDollar !== undefined ? { milesPerDollar: card.milesPerDollar } : {}),
      annualFeeSgd: card.annualFeeSgd,
    };
    onSave(draft, editingIndex);
    resetForm();
    setOpen(false);
  }

  return (
    <section className="card">
      <div className="card-title-row">
        <h2 className="card-title">Your own cards</h2>
        <button
          type="button"
          className="btn btn-ghost"
          aria-expanded={open}
          onClick={() => setOpen((previous) => !previous)}
        >
          {open ? 'Close' : 'Add your own card'}
        </button>
      </div>
      <p className="muted">
        Enter the terms from your card statement; the engine routes on them exactly like the
        built-ins and every custom card is labelled as user-entered.
      </p>

      {open ? (
        <div className="custom-form">
          <div className="field-row">
            <label className="field">
              <span>Card name</span>
              <input
                type="text"
                value={form.name}
                maxLength={60}
                placeholder="My Everyday Card"
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>Issuer</span>
              <input
                type="text"
                value={form.issuer}
                maxLength={60}
                placeholder="Personal"
                onChange={(event) => setForm((prev) => ({ ...prev, issuer: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>Reward type</span>
              <select
                value={form.rewardType}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    rewardType: event.target.value === 'miles' ? 'miles' : 'cashback',
                  }))
                }
              >
                <option value="cashback">Cashback</option>
                <option value="miles">Miles</option>
              </select>
            </label>
            <label className="field">
              <span>{miles ? 'Base rate (mpd)' : 'Base rate (%)'}</span>
              <input
                type="number"
                min={0}
                step={miles ? 0.1 : 0.01}
                value={form.baseRate}
                placeholder={miles ? '1.2' : '1.5'}
                onChange={(event) => setForm((prev) => ({ ...prev, baseRate: event.target.value }))}
              />
            </label>
          </div>

          <div className="tier-editor">
            <div className="tier-editor-head">
              <span className="section-subtitle">Bonus tiers</span>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={addTier}
                disabled={form.tiers.length >= MAX_CUSTOM_TIERS}
              >
                Add tier
              </button>
            </div>
            {form.tiers.length === 0 ? (
              <p className="muted">No bonus tiers: every purchase earns the base rate.</p>
            ) : (
              <div className="tier-rows">
                {form.tiers.map((tier, index) => (
                  <div key={index} className="tier-row">
                    <label className="field">
                      <span>Category</span>
                      <select
                        value={tier.category}
                        onChange={(event) =>
                          updateTier(index, { category: event.target.value as ExpenseCategory })
                        }
                      >
                        {CATEGORIES.map((category) => (
                          <option key={category.value} value={category.value}>
                            {category.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>{rateLabel}</span>
                      <input
                        type="number"
                        min={0}
                        step={miles ? 0.1 : 0.01}
                        value={tier.rate}
                        placeholder={miles ? '4' : '6'}
                        onChange={(event) => updateTier(index, { rate: event.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>Monthly cap (S$, optional)</span>
                      <input
                        type="number"
                        min={0}
                        step={10}
                        value={tier.cap}
                        placeholder="600"
                        onChange={(event) => updateTier(index, { cap: event.target.value })}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost btn-small tier-remove"
                      aria-label={`Remove bonus tier ${index + 1}`}
                      onClick={() => removeTier(index)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="field-row">
            <label className="field">
              <span>Minimum monthly spend (S$, optional)</span>
              <input
                type="number"
                min={0}
                step={50}
                value={form.minSpend}
                placeholder="500"
                onChange={(event) => setForm((prev) => ({ ...prev, minSpend: event.target.value }))}
              />
            </label>
            {miles ? (
              <label className="field">
                <span>Miles per dollar</span>
                <input
                  type="number"
                  min={0.5}
                  max={10}
                  step={0.1}
                  value={form.milesPerDollar}
                  placeholder="4"
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, milesPerDollar: event.target.value }))
                  }
                />
              </label>
            ) : null}
            <label className="field">
              <span>Annual fee (S$)</span>
              <input
                type="number"
                min={0}
                step={10}
                value={form.annualFee}
                onChange={(event) => setForm((prev) => ({ ...prev, annualFee: event.target.value }))}
              />
            </label>
          </div>

          {errors.length > 0 ? (
            <ul className="form-errors" role="alert">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}

          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={handleSave}>
              {editingIndex === null ? 'Save card' : 'Save changes'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={resetForm}>
              {editingIndex === null ? 'Clear form' : 'Cancel edit'}
            </button>
            <span className="muted form-hint">
              Rates are sanity checked (cashback up to 20 percent) before anything is saved.
            </span>
          </div>
        </div>
      ) : null}

      {stored.length > 0 ? (
        <ul className="custom-card-list">
          {stored.map((draft, index) => (
            <li key={`${draft.name}-${index}`} className="custom-card-item">
              <div className="custom-card-body">
                <span className="custom-card-name">
                  {draft.name} <span className="custom-badge">Custom</span>
                </span>
                <span className="custom-card-meta">
                  {draft.issuer} ·{' '}
                  {draft.rewardType === 'miles'
                    ? `${draft.baseRate} mpd base`
                    : `${fmtPct(draft.baseRate)} base`}
                  {draft.earnStructure.length > 0 ? ` · ${draft.earnStructure.length} bonus tier${draft.earnStructure.length === 1 ? '' : 's'}` : ''}
                  {draft.minMonthlySpendSgd !== undefined
                    ? ` · min ${fmtMoney(draft.minMonthlySpendSgd)}/mo`
                    : ''}{' '}
                  · fee {fmtMoney(draft.annualFeeSgd)}/yr
                </span>
              </div>
              <div className="custom-card-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={() => startEdit(index)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-small btn-danger"
                  onClick={() => onDelete(index)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted source-note">No custom cards saved yet.</p>
      )}
    </section>
  );
}
