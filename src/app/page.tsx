'use client';

/**
 * SpendWise client shell: sticky header with a segmented switcher over two
 * tabs of client-side state.
 *
 * Tab one (Goal Planner) posts the prompt and profile to /api/plan and renders
 * the returned PlanJSON. Tab two (Card Maximizer) runs the deterministic
 * routing engine entirely in the browser with zero model calls, over the
 * merged deck of built-in cards plus the user's own saved cards.
 *
 * Client state persists in localStorage under sw_profile, sw_wallet, sw_ledger
 * and sw_custom_cards. Storage reads happen inside effects so server
 * prerender and client hydration always agree, and every key stays backward
 * compatible: profiles saved before the investment fields simply hydrate with
 * those inputs empty.
 */
import { useEffect, useMemo, useState } from 'react';

import { mergeCards } from '../lib/cards/custom';
import type { CardSpec } from '../lib/cards/types';
import { CARDS } from '../lib/data/cards';
import type { PlanJSON } from '../lib/planner/build';
import type { UserProfile } from '../lib/planner/goalspec';
import { goalNameFromSpec, goalSlug, rateFromAssumptions, type TrackedGoal } from '../lib/planner/progress';

import { Header } from './components/header';
import { PlannerTab } from './components/planner-tab';
import { CardsTab } from './components/cards-tab';
import { DashboardTab } from './components/dashboard-tab';
import { buildSampleMonth } from './components/ledger-manager';
import {
  CUSTOM_CARDS_KEY,
  DEFAULT_PROFILE,
  DEFAULT_PROMPT,
  GOALS_KEY,
  LEDGER_KEY,
  MILES_VALUATION_MAX,
  MILES_VALUATION_MIN,
  PROFILE_KEY,
  WALLET_KEY,
  clamp,
  currentMonthKey,
  customCardsFromStored,
  defaultProfileForm,
  isCustomCardStored,
  isGoalSpec,
  isLedgerRow,
  isTrackedGoal,
  profileFromForm,
  type CustomCardStored,
  type LedgerRow,
  type PlanResult,
  type ProfileFormState,
  type TabId,
} from './components/shared';

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>('planner');
  const [hydrated, setHydrated] = useState(false);
  const [monthKey, setMonthKey] = useState('');

  // Planner tab state.
  const [profileForm, setProfileForm] = useState<ProfileFormState>(defaultProfileForm);
  const [milesValuation, setMilesValuation] = useState(DEFAULT_PROFILE.milesValuationCents);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);

  // Cards tab state.
  const [wallet, setWallet] = useState<string[]>([]);
  const [customStored, setCustomStored] = useState<CustomCardStored[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);

  // Progress tab state.
  const [goals, setGoals] = useState<TrackedGoal[]>([]);

  // Hydrate from localStorage after mount so SSR and first render agree.
  useEffect(() => {
    try {
      // Custom cards first: whether a stored wallet id is still valid depends
      // on the merged deck they produce.
      const rawCustom = window.localStorage.getItem(CUSTOM_CARDS_KEY);
      if (rawCustom !== null) {
        const stored: unknown = JSON.parse(rawCustom);
        if (Array.isArray(stored)) {
          setCustomStored(stored.filter(isCustomCardStored));
        }
      }
      const rawProfile = window.localStorage.getItem(PROFILE_KEY);
      if (rawProfile !== null) {
        const stored = JSON.parse(rawProfile) as Partial<UserProfile>;
        const base = defaultProfileForm();
        setProfileForm({
          age: String(stored.age ?? base.age),
          grossMonthlyIncome: String(stored.grossMonthlyIncome ?? base.grossMonthlyIncome),
          monthlyExpenses: String(stored.monthlyExpenses ?? base.monthlyExpenses),
          liquidSavings: String(stored.liquidSavings ?? base.liquidSavings),
          cpfOaBalance: String(stored.cpfOaBalance ?? base.cpfOaBalance),
          investmentsSgd:
            typeof stored.investmentsSgd === 'number' && Number.isFinite(stored.investmentsSgd)
              ? String(stored.investmentsSgd)
              : '',
          investmentRatePct:
            typeof stored.investmentRatePa === 'number' && Number.isFinite(stored.investmentRatePa)
              ? String(stored.investmentRatePa * 100)
              : '',
        });
        if (typeof stored.milesValuationCents === 'number' && Number.isFinite(stored.milesValuationCents)) {
          setMilesValuation(clamp(stored.milesValuationCents, MILES_VALUATION_MIN, MILES_VALUATION_MAX));
        }
      }
      const rawWallet = window.localStorage.getItem(WALLET_KEY);
      if (rawWallet !== null) {
        const ids: unknown = JSON.parse(rawWallet);
        if (Array.isArray(ids)) {
          setWallet(ids.filter((id): id is string => typeof id === 'string'));
        }
      }
      const rawLedger = window.localStorage.getItem(LEDGER_KEY);
      if (rawLedger !== null) {
        const entries: unknown = JSON.parse(rawLedger);
        if (Array.isArray(entries)) {
          setLedger(entries.filter(isLedgerRow));
        }
      }
      const rawGoals = window.localStorage.getItem(GOALS_KEY);
      if (rawGoals !== null) {
        const stored: unknown = JSON.parse(rawGoals);
        if (Array.isArray(stored)) {
          setGoals(stored.filter(isTrackedGoal));
        }
      }
    } catch {
      // Corrupt storage falls back to defaults; nothing to recover here.
    }
    setMonthKey(currentMonthKey(new Date()));
    setHydrated(true);
  }, []);

  // Persist after hydration so the load effect never fights the save effects.
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profileFromForm(profileForm, milesValuation)));
  }, [hydrated, profileForm, milesValuation]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(WALLET_KEY, JSON.stringify(wallet));
  }, [hydrated, wallet]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  }, [hydrated, ledger]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(CUSTOM_CARDS_KEY, JSON.stringify(customStored));
  }, [hydrated, customStored]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(GOALS_KEY, JSON.stringify(goals));
  }, [hydrated, goals]);

  const customCards = useMemo(() => customCardsFromStored(customStored), [customStored]);
  const allCards: CardSpec[] = useMemo(() => mergeCards(CARDS, customCards), [customCards]);

  // Wallet ids that no longer resolve (a custom card was deleted) drop out.
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    setWallet((previous) => {
      const valid = previous.filter((id) => allCards.some((card) => card.id === id));
      return valid.length === previous.length ? previous : valid;
    });
  }, [allCards, hydrated]);

  function toggleWallet(id: string): void {
    setWallet((previous) =>
      previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id]
    );
  }

  function updateProfileField(field: keyof ProfileFormState, raw: string): void {
    setProfileForm((previous) => ({ ...previous, [field]: raw }));
  }

  function saveCustomCard(draft: CustomCardStored, editingIndex: number | null): void {
    setCustomStored((previous) =>
      editingIndex === null
        ? [...previous, draft]
        : previous.map((existing, index) => (index === editingIndex ? draft : existing))
    );
  }

  function deleteCustomCard(index: number): void {
    setCustomStored((previous) => previous.filter((_, index_) => index_ !== index));
  }

  function deleteLedgerEntry(ledgerIndex: number): void {
    setLedger((previous) => previous.filter((_, index) => index !== ledgerIndex));
  }

  function clearMonth(): void {
    setLedger((previous) => previous.filter((entry) => entry.monthKey !== monthKey));
  }

  function loadSampleMonth(): void {
    if (monthKey === '') {
      return;
    }
    setLedger((previous) => [
      ...previous.filter((entry) => entry.monthKey !== monthKey),
      ...buildSampleMonth(monthKey),
    ]);
  }

  function appendLedgerEntry(entry: LedgerRow): void {
    setLedger((previous) => [...previous, entry]);
  }

  // Progress tab handlers.

  function trackCurrentGoal(): void {
    if (planResult === null || planResult.goalSpec === undefined || monthKey === '') {
      return;
    }
    const spec = planResult.goalSpec;
    const plan = planResult.plan;
    const profile = profileFromForm(profileForm, milesValuation);
    const schedule = plan.savingsSchedule;
    const lastBalance = schedule.length > 0 ? schedule[schedule.length - 1]?.balance : undefined;
    const name = goalNameFromSpec(spec);
    const deadlineAssumption = plan.assumptions.find((entry) => entry.field === 'deadlineAge');
    const deadlineAge =
      spec.deadlineAge > profile.age
        ? spec.deadlineAge
        : deadlineAssumption !== undefined && deadlineAssumption.value > profile.age
          ? deadlineAssumption.value
          : profile.age + 5;
    const target =
      lastBalance !== undefined && lastBalance > 0
        ? lastBalance
        : Math.max(0, plan.requiredMonthlySavings * Math.max(1, (deadlineAge - profile.age) * 12));
    const tracked: TrackedGoal = {
      id: goalSlug(name),
      name,
      goalSpec: spec,
      targetSgd: target,
      requiredMonthlySgd: Math.max(0, plan.requiredMonthlySavings),
      ratePa: rateFromAssumptions(plan.assumptions),
      startAge: profile.age,
      startSavingsSgd: Math.max(0, profile.liquidSavings),
      deadlineAge,
      startMonthKey: monthKey,
      logs: [],
    };
    // Re-tracking the same goal re-baselines it: the old logs belong to the
    // old starting point.
    setGoals((previous) => {
      const existing = previous.findIndex((goal) => goal.id === tracked.id);
      if (existing === -1) {
        return [...previous, tracked];
      }
      const next = [...previous];
      next[existing] = tracked;
      return next;
    });
    setActiveTab('progress');
  }

  function deleteGoal(goalId: string): void {
    setGoals((previous) => previous.filter((goal) => goal.id !== goalId));
  }

  function logSavings(goalId: string, logMonthKey: string, contributedSgd: number, note: string): void {
    setGoals((previous) =>
      previous.map((goal) =>
        goal.id === goalId
          ? {
              ...goal,
              logs: [
                ...goal.logs.filter((log) => log.monthKey !== logMonthKey),
                { monthKey: logMonthKey, contributedSgd, ...(note !== '' ? { note } : {}) },
              ],
            }
          : goal
      )
    );
  }

  function deleteLog(goalId: string, logMonthKey: string): void {
    setGoals((previous) =>
      previous.map((goal) =>
        goal.id === goalId
          ? { ...goal, logs: goal.logs.filter((log) => log.monthKey !== logMonthKey) }
          : goal
      )
    );
  }

  async function handlePlan(): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setPlanError('Write a goal first, for example "buy a HDB worth 600k by age 28".');
      setPlanResult(null);
      return;
    }
    setPlanning(true);
    setPlanError(null);
    try {
      const response = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed, profile: profileFromForm(profileForm, milesValuation) }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const message =
          data !== null && typeof data === 'object' && 'error' in data
            ? String((data as { error: unknown }).error)
            : `Plan request failed with status ${response.status}.`;
        setPlanError(message);
        setPlanResult(null);
      } else {
        const payload = data as { plan: PlanJSON; parser?: string; goalSpec?: unknown };
        setPlanResult({
          plan: payload.plan,
          parser: payload.parser === 'nemotron' ? 'nemotron' : 'local-fallback',
          ...(isGoalSpec(payload.goalSpec) ? { goalSpec: payload.goalSpec } : {}),
        });
      }
    } catch {
      setPlanError('Could not reach the planner API. Check that the server is running.');
      setPlanResult(null);
    } finally {
      setPlanning(false);
    }
  }

  return (
    <>
      <Header activeTab={activeTab} onSelectTab={setActiveTab} />
      <main className="page">
        <p className="page-intro">
          Deterministic goal planning and credit card routing for Singapore. Illustrative
          numbers, real math.
        </p>

        {activeTab === 'planner' ? (
          <div role="tabpanel" id="panel-planner" aria-labelledby="tab-planner" className="stack">
            <PlannerTab
              profileForm={profileForm}
              onProfileField={updateProfileField}
              prompt={prompt}
              onPromptChange={setPrompt}
              planning={planning}
              planError={planError}
              planResult={planResult}
              onPlan={handlePlan}
              onTrackGoal={trackCurrentGoal}
            />
          </div>
        ) : activeTab === 'progress' ? (
          <div role="tabpanel" id="panel-progress" aria-labelledby="tab-progress" className="stack">
            <DashboardTab
              goals={goals}
              profile={profileFromForm(profileForm, milesValuation)}
              monthKey={monthKey}
              onDeleteGoal={deleteGoal}
              onLogSavings={logSavings}
              onDeleteLog={deleteLog}
              onGoToPlanner={setActiveTab}
            />
          </div>
        ) : (
          <div role="tabpanel" id="panel-cards" aria-labelledby="tab-cards" className="stack">
            <CardsTab
              wallet={wallet}
              onToggleWallet={toggleWallet}
              allCards={allCards}
              customStored={customStored}
              onSaveCustom={saveCustomCard}
              onDeleteCustom={deleteCustomCard}
              ledger={ledger}
              monthKey={monthKey}
              milesValuation={milesValuation}
              onMilesValuationChange={setMilesValuation}
              onDeleteLedgerEntry={deleteLedgerEntry}
              onClearMonth={clearMonth}
              onLoadSampleMonth={loadSampleMonth}
              onAppendEntry={appendLedgerEntry}
            />
          </div>
        )}

        <footer className="app-footer">
          <p>
            Educational hackathon demo, not financial advice. Duty tables, loan caps and card
            terms are illustrative snapshots that must be verified against IRAS, MAS, CPF and
            the issuers.
          </p>
        </footer>
      </main>
    </>
  );
}
