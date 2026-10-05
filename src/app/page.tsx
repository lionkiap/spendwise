'use client';

/**
 * SpendWise client shell: sticky header with a segmented switcher over three
 * tabs of client-side state, and three spaces underneath: You, Partner and Us.
 *
 * Tab one (Goal Planner) posts the prompt and profile to /api/plan and renders
 * the returned PlanJSON. Tab two (Progress) tracks logged savings against the
 * plan. Tab three (Card Maximizer) runs the deterministic routing engine
 * entirely in the browser with zero model calls, over the merged deck of
 * built-in cards plus the user's own saved cards.
 *
 * The you and partner spaces each carry their own profile form, wallet and
 * ledger; the us space carries a shared wallet and ledger and plans on
 * combineProfiles(you, partner). The dashboard filters tracked goals by
 * space. A user who never opens the partner space sees the exact app they
 * had: on hydrate migrateLegacyStorage copies the pre-couples sw_profile,
 * sw_wallet and sw_ledger into the you space once, and nothing is ever
 * deleted.
 *
 * Storage: sw_space_active, sw_profile_you, sw_profile_partner,
 * sw_wallet_you, sw_wallet_partner, sw_wallet_us, sw_ledger_you,
 * sw_ledger_partner, sw_ledger_us, plus the shared sw_custom_cards and
 * sw_goals. Storage reads happen inside effects so server prerender and
 * client hydration always agree, and every key stays backward compatible.
 */
import { useEffect, useMemo, useState } from 'react';

import { mergeCards } from '../lib/cards/custom';
import type { CardSpec } from '../lib/cards/types';
import { CARDS } from '../lib/data/cards';
import type { PlanJSON } from '../lib/planner/build';
import { combineProfiles, type UserProfile } from '../lib/planner/goalspec';
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
  MILES_VALUATION_MAX,
  MILES_VALUATION_MIN,
  PERSON_SPACE_IDS,
  SPACE_ACTIVE_KEY,
  SPACE_IDS,
  clamp,
  currentMonthKey,
  customCardsFromStored,
  defaultProfileForm,
  isCustomCardStored,
  isGoalSpec,
  isLedgerRow,
  isTrackedGoal,
  ledgerKeyFor,
  migrateLegacyStorage,
  profileKeyFor,
  profileFromForm,
  walletKeyFor,
  type CustomCardStored,
  type LedgerRow,
  type PersonSpace,
  type PlanResult,
  type ProfileFormState,
  type SpaceId,
  type TabId,
} from './components/shared';

/** A stored profile plus its miles valuation, or null when the key is absent. */
function readStoredProfile(
  raw: string | null
): { form: ProfileFormState; milesValuationCents: number } | null {
  if (raw === null) {
    return null;
  }
  const stored = JSON.parse(raw) as Partial<UserProfile>;
  const base = defaultProfileForm();
  return {
    form: {
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
    },
    milesValuationCents:
      typeof stored.milesValuationCents === 'number' && Number.isFinite(stored.milesValuationCents)
        ? clamp(stored.milesValuationCents, MILES_VALUATION_MIN, MILES_VALUATION_MAX)
        : DEFAULT_PROFILE.milesValuationCents,
  };
}

function readStringArray(raw: string | null): string[] | null {
  if (raw === null) {
    return null;
  }
  const ids: unknown = JSON.parse(raw);
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

function readLedger(raw: string | null): LedgerRow[] | null {
  if (raw === null) {
    return null;
  }
  const entries: unknown = JSON.parse(raw);
  return Array.isArray(entries) ? entries.filter(isLedgerRow) : [];
}

function readSpace(raw: string | null): SpaceId | null {
  return raw === 'you' || raw === 'partner' || raw === 'us' ? raw : null;
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>('planner');
  const [activeSpace, setActiveSpace] = useState<SpaceId>('you');
  const [hydrated, setHydrated] = useState(false);
  const [monthKey, setMonthKey] = useState('');

  // Planner tab state. The prompt and the latest plan are shared across
  // spaces; the profile forms are per person.
  const [profileForms, setProfileForms] = useState<Record<PersonSpace, ProfileFormState>>({
    you: defaultProfileForm(),
    partner: defaultProfileForm(),
  });
  const [milesValuations, setMilesValuations] = useState<Record<PersonSpace, number>>({
    you: DEFAULT_PROFILE.milesValuationCents,
    partner: DEFAULT_PROFILE.milesValuationCents,
  });
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);

  // Cards tab state: one wallet and one ledger per space.
  const [wallets, setWallets] = useState<Record<SpaceId, string[]>>({
    you: [],
    partner: [],
    us: [],
  });
  const [customStored, setCustomStored] = useState<CustomCardStored[]>([]);
  const [ledgers, setLedgers] = useState<Record<SpaceId, LedgerRow[]>>({
    you: [],
    partner: [],
    us: [],
  });

  // Progress tab state. Goals carry their own space field.
  const [goals, setGoals] = useState<TrackedGoal[]>([]);

  // Hydrate from localStorage after mount so SSR and first render agree.
  useEffect(() => {
    try {
      // Legacy first: the per-space reads below must see pre-couples data
      // already copied into the you space. Idempotent, deletes nothing.
      migrateLegacyStorage();

      // Custom cards next: whether a stored wallet id is still valid depends
      // on the merged deck they produce.
      const rawCustom = window.localStorage.getItem(CUSTOM_CARDS_KEY);
      if (rawCustom !== null) {
        const stored: unknown = JSON.parse(rawCustom);
        if (Array.isArray(stored)) {
          setCustomStored(stored.filter(isCustomCardStored));
        }
      }

      for (const person of PERSON_SPACE_IDS) {
        const stored = readStoredProfile(window.localStorage.getItem(profileKeyFor(person)));
        if (stored !== null) {
          setProfileForms((previous) => ({ ...previous, [person]: stored.form }));
          setMilesValuations((previous) => ({ ...previous, [person]: stored.milesValuationCents }));
        }
      }

      const walletState: Partial<Record<SpaceId, string[]>> = {};
      for (const space of SPACE_IDS) {
        const stored = readStringArray(window.localStorage.getItem(walletKeyFor(space)));
        if (stored !== null) {
          walletState[space] = stored;
        }
      }
      setWallets((previous) => ({ ...previous, ...walletState }));

      const ledgerState: Partial<Record<SpaceId, LedgerRow[]>> = {};
      for (const space of SPACE_IDS) {
        const stored = readLedger(window.localStorage.getItem(ledgerKeyFor(space)));
        if (stored !== null) {
          ledgerState[space] = stored;
        }
      }
      setLedgers((previous) => ({ ...previous, ...ledgerState }));

      const rawGoals = window.localStorage.getItem(GOALS_KEY);
      if (rawGoals !== null) {
        const stored: unknown = JSON.parse(rawGoals);
        if (Array.isArray(stored)) {
          setGoals(stored.filter(isTrackedGoal));
        }
      }

      const storedSpace = readSpace(window.localStorage.getItem(SPACE_ACTIVE_KEY));
      if (storedSpace !== null) {
        setActiveSpace(storedSpace);
      }
    } catch {
      // Corrupt storage falls back to defaults; nothing to recover here.
    }
    setMonthKey(currentMonthKey(new Date()));
    setHydrated(true);
  }, []);

  // The two personal profiles, derived once and reused everywhere: the you
  // and partner planner forms post them as they are, and the us space plans
  // on their combination.
  const youProfile = useMemo(
    () => profileFromForm(profileForms.you, milesValuations.you),
    [profileForms.you, milesValuations.you]
  );
  const partnerProfile = useMemo(
    () => profileFromForm(profileForms.partner, milesValuations.partner),
    [profileForms.partner, milesValuations.partner]
  );
  const activeProfile = useMemo<UserProfile>(() => {
    if (activeSpace === 'partner') {
      return partnerProfile;
    }
    if (activeSpace === 'us') {
      return combineProfiles(youProfile, partnerProfile);
    }
    return youProfile;
  }, [activeSpace, youProfile, partnerProfile]);

  // Persist after hydration so the load effect never fights the save effects.
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(profileKeyFor('you'), JSON.stringify(youProfile));
  }, [hydrated, youProfile]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(profileKeyFor('partner'), JSON.stringify(partnerProfile));
  }, [hydrated, partnerProfile]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    for (const space of SPACE_IDS) {
      window.localStorage.setItem(walletKeyFor(space), JSON.stringify(wallets[space]));
    }
  }, [hydrated, wallets]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    for (const space of SPACE_IDS) {
      window.localStorage.setItem(ledgerKeyFor(space), JSON.stringify(ledgers[space]));
    }
  }, [hydrated, ledgers]);

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

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(SPACE_ACTIVE_KEY, activeSpace);
  }, [hydrated, activeSpace]);

  const customCards = useMemo(() => customCardsFromStored(customStored), [customStored]);
  const allCards: CardSpec[] = useMemo(() => mergeCards(CARDS, customCards), [customCards]);

  // Wallet ids that no longer resolve (a custom card was deleted) drop out of
  // every space's wallet.
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    setWallets((previous) => {
      let changed = false;
      const next: Record<SpaceId, string[]> = { ...previous };
      for (const space of SPACE_IDS) {
        const valid = previous[space].filter((id) => allCards.some((card) => card.id === id));
        if (valid.length !== previous[space].length) {
          next[space] = valid;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [allCards, hydrated]);

  // In the us space the wallet list stamps each card that already sits in a
  // personal wallet with its owner. You wins a tie: the household values
  // things the primary profile's way (combineProfiles does the same for
  // miles valuation).
  const ownerById = useMemo<Record<string, 'you' | 'partner'> | undefined>(() => {
    if (activeSpace !== 'us') {
      return undefined;
    }
    const owners: Record<string, 'you' | 'partner'> = {};
    for (const id of wallets.partner) {
      if (!(id in owners)) {
        owners[id] = 'partner';
      }
    }
    for (const id of wallets.you) {
      owners[id] = 'you';
    }
    return owners;
  }, [activeSpace, wallets.you, wallets.partner]);

  function toggleWallet(id: string): void {
    const space = activeSpace;
    setWallets((previous) => {
      const current = previous[space];
      return {
        ...previous,
        [space]: current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
      };
    });
  }

  function updateProfileField(field: keyof ProfileFormState, raw: string): void {
    // Only the you and partner spaces render the editable form.
    const person: PersonSpace = activeSpace === 'partner' ? 'partner' : 'you';
    setProfileForms((previous) => ({
      ...previous,
      [person]: { ...previous[person], [field]: raw },
    }));
  }

  /**
   * The miles slider edits the active person's valuation. In the us space it
   * edits you's, because combineProfiles anchors the household's valuation on
   * the primary profile: move the slider in Us and the You space reflects it.
   */
  function changeMilesValuation(value: number): void {
    const person: PersonSpace = activeSpace === 'partner' ? 'partner' : 'you';
    setMilesValuations((previous) => ({
      ...previous,
      [person]: clamp(value, MILES_VALUATION_MIN, MILES_VALUATION_MAX),
    }));
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
    const space = activeSpace;
    setLedgers((previous) => ({
      ...previous,
      [space]: previous[space].filter((_, index) => index !== ledgerIndex),
    }));
  }

  function clearMonth(): void {
    const space = activeSpace;
    setLedgers((previous) => ({
      ...previous,
      [space]: previous[space].filter((entry) => entry.monthKey !== monthKey),
    }));
  }

  function loadSampleMonth(): void {
    if (monthKey === '') {
      return;
    }
    const space = activeSpace;
    setLedgers((previous) => ({
      ...previous,
      [space]: [
        ...previous[space].filter((entry) => entry.monthKey !== monthKey),
        ...buildSampleMonth(monthKey),
      ],
    }));
  }

  function appendLedgerEntry(entry: LedgerRow): void {
    const space = activeSpace;
    setLedgers((previous) => ({ ...previous, [space]: [...previous[space], entry] }));
  }

  // Progress tab handlers.

  function trackCurrentGoal(): void {
    if (planResult === null || planResult.goalSpec === undefined || monthKey === '') {
      return;
    }
    const spec = planResult.goalSpec;
    const plan = planResult.plan;
    const profile = activeProfile;
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
      space: activeSpace,
      logs: [],
    };
    // Re-tracking the same goal re-baselines it: the old logs belong to the
    // old starting point. Goal ids only collide within a space, so the same
    // goal name tracked in You and in Us keeps two separate histories.
    setGoals((previous) => {
      const existing = previous.findIndex(
        (goal) => goal.id === tracked.id && (goal.space ?? 'you') === activeSpace
      );
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

  function logSavings(
    goalId: string,
    logMonthKey: string,
    contributedSgd: number,
    note: string,
    contributor: 'you' | 'partner'
  ): void {
    setGoals((previous) =>
      previous.map((goal) =>
        goal.id === goalId
          ? {
              ...goal,
              logs: [
                ...goal.logs.filter((log) => log.monthKey !== logMonthKey),
                { monthKey: logMonthKey, contributedSgd, contributor, ...(note !== '' ? { note } : {}) },
              ],
            }
          : goal
      )
    );
  }

  function deleteLog(goalId: string, logMonthKey: string): void {
    setGoals((previous) =>
      previous.map((goal) =>
        goal.id === goalId ? { ...goal, logs: goal.logs.filter((log) => log.monthKey !== logMonthKey) } : goal
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
        body: JSON.stringify({ prompt: trimmed, profile: activeProfile }),
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

  function selectSpace(space: SpaceId): void {
    setActiveSpace(space);
    // A plan computed against another space's profile must not linger on
    // screen after the switch; the Plan button is the only replan trigger.
    setPlanResult(null);
    setPlanError(null);
  }

  return (
    <>
      <Header
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        activeSpace={activeSpace}
        onSelectSpace={selectSpace}
      />
      <main className="page">
        <p className="page-intro">
          Deterministic goal planning and credit card routing for Singapore. Illustrative
          numbers, real math.
        </p>

        {activeTab === 'planner' ? (
          <div role="tabpanel" id="panel-planner" aria-labelledby="tab-planner" className="stack">
            <PlannerTab
              space={activeSpace}
              profileForm={profileForms[activeSpace === 'partner' ? 'partner' : 'you']}
              onProfileField={updateProfileField}
              householdProfile={activeProfile}
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
              space={activeSpace}
              goals={goals.filter((goal) => (goal.space ?? 'you') === activeSpace)}
              profile={activeProfile}
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
              wallet={wallets[activeSpace]}
              onToggleWallet={toggleWallet}
              allCards={allCards}
              customStored={customStored}
              onSaveCustom={saveCustomCard}
              onDeleteCustom={deleteCustomCard}
              ledger={ledgers[activeSpace]}
              monthKey={monthKey}
              milesValuation={activeProfile.milesValuationCents}
              onMilesValuationChange={changeMilesValuation}
              onDeleteLedgerEntry={deleteLedgerEntry}
              onClearMonth={clearMonth}
              onLoadSampleMonth={loadSampleMonth}
              onAppendEntry={appendLedgerEntry}
              ownerById={ownerById}
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
