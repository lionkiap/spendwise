'use client';

/**
 * SpendWise client shell: a fixed sidebar (Dashboard, Goals, Cards, Adviser)
 * plus a top bar that carries the You / Partner / Us space switcher, the
 * Nemotron status pill and the New goal button. Below 900px the sidebar gives
 * way to a compact labelled nav bar under the header, with the profile and
 * data actions in a More sheet.
 *
 * The Goals view holds the planning pipeline (prompt to /api/plan, rendered
 * PlanJSON, what-if advisor over /api/advisor) followed by the tracked-goal
 * detail that used to be the Progress tab. The Cards view runs the
 * deterministic routing engine entirely in the browser with zero model calls,
 * over the merged deck of built-in cards plus the user's own saved cards. The
 * Adviser view is the conversational spending adviser. The active view
 * persists under sw_view and defaults to the Dashboard.
 *
 * The you and partner spaces each carry their own profile form, wallet and
 * ledger; the us space carries a shared wallet and ledger and plans on
 * combineProfiles(you, partner). The dashboard filters tracked goals by
 * space. A user who never opens the partner space sees the exact app they
 * had: on hydrate migrateLegacyStorage copies the pre-couples sw_profile,
 * sw_wallet and sw_ledger into the you space once, and nothing is ever
 * deleted.
 *
 * Storage: sw_space_active, sw_view, sw_profile_you, sw_profile_partner,
 * sw_wallet_you, sw_wallet_partner, sw_wallet_us, sw_ledger_you,
 * sw_ledger_partner, sw_ledger_us, plus the shared sw_custom_cards and
 * sw_goals. Storage reads happen inside effects so server prerender and
 * client hydration always agree, and every key stays backward compatible.
 * The sidebar (More sheet on mobile) exports every sw_ key to a backup file,
 * imports validated backups back, and can seed the guided sample journey
 * through the same keys.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { mergeCards } from '../lib/cards/custom';
import type { CardSpec, ExpenseCategory } from '../lib/cards/types';
import { CARDS } from '../lib/data/cards';
import { buildPlan, type PlanJSON } from '../lib/planner/build';
import { combineProfiles, type GoalSpec, type UserProfile } from '../lib/planner/goalspec';
import { fillAssumptions } from '../lib/planner/parse';
import {
  goalNameFromSpec,
  goalSlug,
  rateFromAssumptions,
  removeGoal,
  removeSavingsLog,
  sameGoal,
  uniqueGoalId,
  upsertSavingsLog,
  type TrackedGoal,
} from '../lib/planner/progress';

import { Header } from './components/header';
import { PlannerTab } from './components/planner-tab';
import { CardsTab } from './components/cards-tab';
import { DashboardTab } from './components/dashboard-tab';
import { DashboardView } from './components/dashboard-view';
import { Sidebar } from './components/sidebar';
import { MobileNav } from './components/mobile-nav';
import { ProfileDrawer } from './components/profile-drawer';
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
  VIEW_ACTIVE_KEY,
  adviserPrefsKeyFor,
  applyAdviserGoalRevision,
  buildBackup,
  buildSampleJourney,
  buildUndoSnapshot,
  clamp,
  currentMonthKey,
  customCardsFromStored,
  defaultProfileForm,
  epochMatches,
  investmentRateFromPlan,
  isCustomCardStored,
  isGoalSpec,
  isLedgerRow,
  isStatusJson,
  isTrackedGoal,
  ledgerKeyFor,
  migrateLegacyStorage,
  parseAdviserPrefs,
  parseBackup,
  parseStoredView,
  pickSelectedGoal,
  profileFormFromRevised,
  profileFromForm,
  profileKeyFor,
  promptFromGoalSpec,
  serializeAdviserPrefs,
  selectedGoalKeyFor,
  toggleProtectedCategory,
  walletKeyFor,
  type AdviserUndoSnapshot,
  type CustomCardStored,
  type LedgerRow,
  type PersonSpace,
  type PlanResult,
  type ProfileFormState,
  type SpaceId,
  type StatusJson,
  type ViewId,
} from './components/shared';
import { AdviserTab, type AdviserExchange } from './components/adviser-tab';

/** A stored profile plus its miles valuation, or null when the key is absent. */
function readStoredProfile(
  raw: string | null
): { form: ProfileFormState; milesValuationCents: number } | null {
  if (raw === null) {
    return null;
  }
  const stored = JSON.parse(raw) as Partial<UserProfile>;
  const base = defaultProfileForm();
  const optionalField = (value: number | undefined): string =>
    typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return {
    form: {
      age: String(stored.age ?? base.age),
      grossMonthlyIncome: String(stored.grossMonthlyIncome ?? base.grossMonthlyIncome),
      monthlyExpenses: String(stored.monthlyExpenses ?? base.monthlyExpenses),
      liquidSavings: String(stored.liquidSavings ?? base.liquidSavings),
      cpfOaBalance: String(stored.cpfOaBalance ?? base.cpfOaBalance),
      investmentsSgd: optionalField(stored.investmentsSgd),
      investmentRatePct:
        typeof stored.investmentRatePa === 'number' && Number.isFinite(stored.investmentRatePa)
          ? String(stored.investmentRatePa * 100)
          : '',
      takeHomeMonthlyIncome: optionalField(stored.takeHomeMonthlyIncome),
      monthlyDebtCommitments: optionalField(stored.monthlyDebtCommitments),
      emergencyReserveMonths: optionalField(stored.emergencyReserveMonths),
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
  const [view, setView] = useState<ViewId>('dashboard');
  const [activeSpace, setActiveSpace] = useState<SpaceId>('you');
  const [hydrated, setHydrated] = useState(false);
  const [monthKey, setMonthKey] = useState('');
  const [importReport, setImportReport] = useState<string | null>(null);
  const [sampleIntroVisible, setSampleIntroVisible] = useState(false);
  const [status, setStatus] = useState<StatusJson | null>(null);
  const [profileDrawerOpen, setProfileDrawerOpen] = useState(false);
  // Bumped by the header's New goal button so the Goals view focuses the
  // goal prompt textarea after it renders.
  const [focusPromptSignal, setFocusPromptSignal] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Space epoch, bumped on every selectSpace. handlePlan captures it before
  // awaiting fetch and drops any reply whose epoch no longer matches, so an
  // in-flight plan built on one space's profile can never render in another
  // space. A ref (not state) because the guard must read the live value inside
  // the async closure; nothing renders from it.
  const spaceEpochRef = useRef(0);

  // Planner state. The prompt and the latest plan are shared across
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

  // Cards state: one wallet and one ledger per space.
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

  // Tracked goals. Goals carry their own space field.
  const [goals, setGoals] = useState<TrackedGoal[]>([]);

  // Adviser state, one record per space: transcripts and model-call
  // counters live in memory, protected categories persist under
  // sw_adviser_prefs_<space>, and each space holds at most one pre-apply undo
  // snapshot (also in memory, one deep).
  const [adviserTranscripts, setAdviserTranscripts] = useState<Record<SpaceId, AdviserExchange[]>>({
    you: [],
    partner: [],
    us: [],
  });
  const [adviserModelCalls, setAdviserModelCalls] = useState<Record<SpaceId, number>>({
    you: 0,
    partner: 0,
    us: 0,
  });
  const [adviserProtected, setAdviserProtected] = useState<Record<SpaceId, ExpenseCategory[]>>({
    you: [],
    partner: [],
    us: [],
  });
  const [adviserUndo, setAdviserUndo] = useState<Partial<Record<SpaceId, AdviserUndoSnapshot>>>({});

  // The dashboard's featured goal: one selection per space, persisted under
  // sw_selected_goal_<space>. A selection whose goal was deleted falls back
  // to the first goal of the space (pickSelectedGoal), never to a crash.
  const [selectedGoalIds, setSelectedGoalIds] = useState<Record<SpaceId, string | null>>({
    you: null,
    partner: null,
    us: null,
  });
  // A question seeded by the dashboard's contextual adviser, consumed once by
  // the Adviser view and cleared again here.
  const [adviserInitialQuestion, setAdviserInitialQuestion] = useState<string | null>(null);
  // Bumped by the header's New goal button so the dashboard composer focuses
  // its textarea after the view renders.
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);

  // Connection truth: one fetch, shared by the header pill and the advisor's
  // engine badge. A failure keeps null, which both render as the local floor.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/status')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (!cancelled && isStatusJson(data)) {
          setStatus(data);
        }
      })
      .catch(() => {
        // Network failure keeps the Local mode pill.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hydrate from localStorage after mount so SSR and first render agree.
  // The reads live in loadStateFromStorage so the import and sample-journey
  // handlers can replay them after writing keys back into localStorage.
  function loadStateFromStorage(): void {
    // Custom cards first: whether a stored wallet id is still valid depends
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

    const prefsState: Partial<Record<SpaceId, ExpenseCategory[]>> = {};
    for (const space of SPACE_IDS) {
      prefsState[space] = parseAdviserPrefs(
        window.localStorage.getItem(adviserPrefsKeyFor(space))
      );
    }
    setAdviserProtected((previous) => ({ ...previous, ...prefsState }));

    const storedSpace = readSpace(window.localStorage.getItem(SPACE_ACTIVE_KEY));
    if (storedSpace !== null) {
      setActiveSpace(storedSpace);
    }

    const storedView = parseStoredView(window.localStorage.getItem(VIEW_ACTIVE_KEY));
    if (storedView !== null) {
      setView(storedView);
    }

    const selectionState: Partial<Record<SpaceId, string | null>> = {};
    for (const space of SPACE_IDS) {
      selectionState[space] = window.localStorage.getItem(selectedGoalKeyFor(space));
    }
    setSelectedGoalIds((previous) => ({ ...previous, ...selectionState }));
  }

  useEffect(() => {
    try {
      // Legacy first: the per-space reads below must see pre-couples data
      // already copied into the you space. Idempotent, deletes nothing.
      migrateLegacyStorage();
      loadStateFromStorage();
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

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(VIEW_ACTIVE_KEY, view);
  }, [hydrated, view]);

  // Protected categories persist per space; later adviser turns read them
  // back from this state, so a toggle is respected by the next suggestion.
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    for (const space of SPACE_IDS) {
      window.localStorage.setItem(
        adviserPrefsKeyFor(space),
        serializeAdviserPrefs(adviserProtected[space])
      );
    }
  }, [hydrated, adviserProtected]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    for (const space of SPACE_IDS) {
      const id = selectedGoalIds[space];
      if (id === null) {
        window.localStorage.removeItem(selectedGoalKeyFor(space));
      } else {
        window.localStorage.setItem(selectedGoalKeyFor(space), id);
      }
    }
  }, [hydrated, selectedGoalIds]);

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
    // Only the you and partner spaces carry the editable form.
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

  // Tracked-goal handlers.

  /**
   * Freeze a validated spec plus its computed plan into a TrackedGoal.
   * Shared by the Goals view's Plan button and the dashboard composer's
   * Save and track, so both entry points capture the same fields.
   */
  function trackedGoalFrom(
    spec: GoalSpec,
    plan: PlanJSON,
    space: SpaceId
  ): TrackedGoal {
    const profile =
      space === 'partner' ? partnerProfile : space === 'us' ? combineProfiles(youProfile, partnerProfile) : youProfile;
    const safeMonthKey = monthKey === '' ? currentMonthKey(new Date()) : monthKey;
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
    return {
      id: goalSlug(name),
      name,
      goalSpec: spec,
      targetSgd: target,
      requiredMonthlySgd: Math.max(0, plan.requiredMonthlySavings),
      ratePa: rateFromAssumptions(plan.assumptions, spec),
      startAge: profile.age,
      startSavingsSgd: Math.max(0, profile.liquidSavings),
      // Freeze the investments leg exactly as the plan built it; goals stored
      // before these fields keep the documented defaults in progress.ts.
      startInvestmentsSgd: Math.max(0, profile.investmentsSgd ?? 0),
      investmentRatePa: investmentRateFromPlan(profile, plan.assumptions),
      deadlineAge,
      startMonthKey: safeMonthKey,
      space,
      logs: [],
    };
  }

  /** Append a tracked goal, select it in its space and land on the dashboard. */
  function appendTrackedGoal(spec: GoalSpec, plan: PlanJSON): void {
    const space = activeSpace;
    setGoals((previous) => {
      const base = trackedGoalFrom(spec, plan, space);
      // Re-tracking never destroys history: uniqueGoalId gives the goal a
      // fresh suffixed id whenever the same slug already exists in this
      // space, and the same name in another space never forces a suffix.
      const id = uniqueGoalId(previous, base.id, space);
      setSelectedGoalIds((selection) => ({ ...selection, [space]: id }));
      return [...previous, { ...base, id }];
    });
    setView('dashboard');
  }

  function trackCurrentGoal(): void {
    if (planResult === null || planResult.goalSpec === undefined) {
      return;
    }
    appendTrackedGoal(planResult.goalSpec, planResult.plan);
  }

  /** The dashboard composer's Save and track: a locally rebuilt preview pair. */
  function trackFromPreview(spec: GoalSpec, plan: PlanJSON): void {
    appendTrackedGoal(spec, plan);
  }

  /** Delete by id plus space: a same-named goal in another space survives. */
  function deleteGoal(target: TrackedGoal): void {
    setGoals((previous) => removeGoal(previous, target.id, target.space));
    setSelectedGoalIds((previous) =>
      previous[target.space ?? 'you'] === target.id
        ? { ...previous, [target.space ?? 'you']: null }
        : previous
    );
  }

  // Adviser handlers. Every callback names its space explicitly: a turn
  // that was asked in one space must land in that space's transcript even if
  // the user switched mid-flight.

  function appendAdviserExchange(space: SpaceId, exchange: AdviserExchange): void {
    setAdviserTranscripts((previous) => ({ ...previous, [space]: [...previous[space], exchange] }));
  }

  function noteAdviserModelCalls(space: SpaceId, used: number): void {
    setAdviserModelCalls((previous) => ({ ...previous, [space]: used }));
  }

  function toggleAdviserProtected(space: SpaceId, category: ExpenseCategory): void {
    setAdviserProtected((previous) => ({
      ...previous,
      [space]: toggleProtectedCategory(previous[space], category),
    }));
  }

  /** A protect_category op adds the category when it is not protected yet. */
  function protectAdviserCategory(space: SpaceId, category: ExpenseCategory): void {
    setAdviserProtected((previous) => ({
      ...previous,
      [space]: previous[space].includes(category)
        ? previous[space]
        : [...previous[space], category],
    }));
  }

  /**
   * Apply a goal-level adviser revision: the goal keeps its id, space and
   * every savings log; only the spec, deadline age and display name move.
   */
  function reviseAdviserGoal(space: SpaceId, goalId: string, revisedGoalSpec: GoalSpec): void {
    setGoals((previous) => applyAdviserGoalRevision(previous, goalId, space, revisedGoalSpec));
  }

  /** Snapshot both profile forms and every goal, one deep, before an apply. */
  function captureAdviserUndo(space: SpaceId): void {
    setAdviserUndo((previous) => ({
      ...previous,
      [space]: buildUndoSnapshot(profileForms, goals),
    }));
  }

  /** One-step Undo: restore the snapshot wholesale and drop it. */
  function undoAdviser(space: SpaceId): void {
    const snapshot = adviserUndo[space];
    if (snapshot === undefined) {
      return;
    }
    setProfileForms(snapshot.profileForms);
    setGoals(snapshot.goals);
    setAdviserUndo((previous) => {
      const next = { ...previous };
      delete next[space];
      return next;
    });
  }

  /**
   * Insert-or-replace one savings log. Storage identity is monthKey AND
   * contributor, enforced by upsertSavingsLog: logging the partner's saving
   * for a month never overwrites the you entry of that month.
   */
  function logSavings(
    target: TrackedGoal,
    logMonthKey: string,
    contributedSgd: number,
    note: string,
    contributor: 'you' | 'partner'
  ): void {
    setGoals((previous) =>
      previous.map((goal) =>
        sameGoal(goal, target)
          ? upsertSavingsLog(goal, {
              monthKey: logMonthKey,
              contributedSgd,
              contributor,
              ...(note !== '' ? { note } : {}),
            })
          : goal
      )
    );
  }

  /** Remove one month's entry for one contributor; the other's survives. */
  function deleteLog(
    target: TrackedGoal,
    logMonthKey: string,
    contributor: 'you' | 'partner'
  ): void {
    setGoals((previous) =>
      previous.map((goal) =>
        sameGoal(goal, target) ? removeSavingsLog(goal, logMonthKey, contributor) : goal
      )
    );
  }

  async function handlePlan(textOverride?: unknown): Promise<void> {
    // The Goals button passes the click event; the dashboard composer passes
    // the raw text. Only a real string overrides the shared prompt state.
    const source = typeof textOverride === 'string' ? textOverride : prompt;
    const trimmed = source.trim();
    if (typeof textOverride === 'string' && textOverride !== prompt) {
      setPrompt(textOverride);
    }
    if (!trimmed) {
      setPlanError('Write a goal first, for example "buy a HDB worth 600k by age 28".');
      setPlanResult(null);
      return;
    }
    // Capture the space epoch before any await: the reply may only land while
    // this value still equals spaceEpochRef.current. A space switch mid-flight
    // bumps the ref, so the stale reply is dropped instead of rendered in the
    // new space (selectSpace already cleared the on-screen plan).
    const epoch = spaceEpochRef.current;
    setPlanning(true);
    setPlanError(null);
    try {
      const response = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed, profile: activeProfile }),
      });
      const data: unknown = await response.json();
      if (!epochMatches(epoch, spaceEpochRef.current)) {
        return;
      }
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
      if (epochMatches(epoch, spaceEpochRef.current)) {
        setPlanError('Could not reach the planner API. Check that the server is running.');
        setPlanResult(null);
      }
    } finally {
      setPlanning(false);
    }
  }

  /**
   * Apply an advisor revision. The prompt is rebuilt from the revised goal
   * spec's summary fields and the rendered plan is rebuilt right here with
   * the same deterministic buildPlan and fillAssumptions the /api/plan route
   * uses, so Apply needs no second network call and every number still comes
   * from the kernels. In a personal space the revised profile also lands in
   * that person's form (fields the advisor wire cannot carry keep their
   * current value); in the Us space the profile cannot be split back into
   * per-person forms, which the advisor card itself notes.
   */
  function applyAdvisorRevision(revisedGoalSpec: GoalSpec, revisedProfile: UserProfile): void {
    setPrompt(promptFromGoalSpec(revisedGoalSpec));
    if (planResult !== null) {
      setPlanResult({
        plan: buildPlan(revisedGoalSpec, revisedProfile, fillAssumptions(revisedGoalSpec, revisedProfile)),
        parser: planResult.parser,
        goalSpec: revisedGoalSpec,
      });
    }
    if (activeSpace !== 'us') {
      const person: PersonSpace = activeSpace === 'partner' ? 'partner' : 'you';
      setProfileForms((previous) => ({
        ...previous,
        [person]: profileFormFromRevised(revisedProfile, previous[person]),
      }));
    }
  }

  function selectSpace(space: SpaceId): void {
    // Every switch bumps the epoch first, so any plan request still in flight
    // for the previous space drops its reply when it lands.
    spaceEpochRef.current += 1;
    setActiveSpace(space);
    // A plan computed against another space's profile must not linger on
    // screen after the switch; the Plan button is the only replan trigger.
    setPlanResult(null);
    setPlanError(null);
  }

  /**
   * The header's New goal button: both entry points share the dashboard
   * composer, so focus it there once the view renders.
   */
  function handleNewGoal(): void {
    setView('dashboard');
    setComposerFocusSignal((previous) => previous + 1);
  }

  /** The dashboard composer's Build my plan. */
  function handleBuildPlan(text: string): void {
    void handlePlan(text);
  }

  /** The dashboard's contextual adviser: seed the question and jump over. */
  function handleAskAdviser(question: string): void {
    setAdviserInitialQuestion(question);
    setView('adviser');
  }

  /** The take-home assumption chip's override, routed to the profile setter. */
  function commitTakeHome(value: string): void {
    updateProfileField('takeHomeMonthlyIncome', value);
  }

  // Data protection: every sw_ key, serialised into one downloadable file.

  /** Export every sw_ prefixed localStorage key as a spendwise-backup JSON. */
  function exportData(): void {
    const data: Record<string, string> = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null && key.startsWith('sw_')) {
        const value = window.localStorage.getItem(key);
        if (value !== null) {
          data[key] = value;
        }
      }
    }
    const backup = buildBackup(data, new Date().toISOString());
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'spendwise-backup.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Import a backup file: write only the keys that pass parseBackup's guards,
   * reload all state from storage, and report what was skipped. The Date use
   * is allowed in src/app client handlers.
   */
  async function importData(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImportReport('Import failed: the file could not be read.');
      return;
    }
    const result = parseBackup(text);
    if (!result.ok) {
      setImportReport(`Import failed: ${result.error}.`);
      return;
    }
    const { entries, skipped, exportedAtIso } = result.plan;
    for (const entry of entries) {
      window.localStorage.setItem(entry.key, entry.value);
    }
    try {
      loadStateFromStorage();
    } catch {
      // A validated backup should always load; if it somehow does not, the
      // defaults apply exactly as on a corrupt first hydrate.
    }
    const parts = [
      `Imported ${entries.length} key${entries.length === 1 ? '' : 's'} from the backup of ${exportedAtIso}.`,
      ...(skipped.length > 0
        ? [`Skipped: ${skipped.map((entry) => `${entry.key} (${entry.reason})`).join(', ')}.`]
        : []),
    ];
    setImportReport(parts.join(' '));
  }

  function onImportFileChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file !== undefined) {
      void importData(file);
    }
    // Reset so picking the same file twice re-fires the change event.
    event.target.value = '';
  }

  /**
   * Seed the guided sample journey through the existing storage keys, then
   * land on the Us dashboard with the four-step intro card showing. The
   * button confirms first: seeding overwrites the profiles, personal wallets,
   * tracked goals and active space it touches.
   */
  function trySampleJourney(): void {
    const confirmed = window.confirm(
      'The sample journey replaces your saved profiles, personal wallets, tracked goals and active space with demo data. Continue?'
    );
    if (!confirmed) {
      return;
    }
    const seed = buildSampleJourney(monthKey === '' ? currentMonthKey(new Date()) : monthKey);
    for (const key of Object.keys(seed)) {
      window.localStorage.setItem(key, seed[key]);
    }
    try {
      loadStateFromStorage();
    } catch {
      // The seed is validated data; on a freak failure the defaults apply.
    }
    // A stale plan from the pre-seed profile must not linger.
    setPlanResult(null);
    setPlanError(null);
    setView('dashboard');
    setSampleIntroVisible(true);
  }

  const goalsInSpace = goals.filter((goal) => (goal.space ?? 'you') === activeSpace);

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        onSelectView={setView}
        space={activeSpace}
        profile={activeProfile}
        onEditProfile={() => setProfileDrawerOpen(true)}
        onExport={exportData}
        onImport={() => fileInputRef.current?.click()}
        onTrySample={trySampleJourney}
        importReport={importReport}
      />
      <div className="app-main">
        <Header
          activeSpace={activeSpace}
          onSelectSpace={selectSpace}
          status={status}
          onNewGoal={handleNewGoal}
        />
        <MobileNav
          view={view}
          onSelectView={setView}
          space={activeSpace}
          profile={activeProfile}
          onEditProfile={() => setProfileDrawerOpen(true)}
          onExport={exportData}
          onImport={() => fileInputRef.current?.click()}
          onTrySample={trySampleJourney}
          importReport={importReport}
        />
        <main className="page">
          <p className="page-intro reading">
            Deterministic goal planning and credit card routing for Singapore. Illustrative
            numbers, real math.
          </p>

          {view === 'dashboard' ? (
            <div className="view-panel stack" id="view-dashboard">
              {sampleIntroVisible ? (
                <SampleIntroCard onDismiss={() => setSampleIntroVisible(false)} />
              ) : null}
              <DashboardView
                space={activeSpace}
                goals={goalsInSpace}
                profile={activeProfile}
                monthKey={monthKey}
                selectedGoalId={pickSelectedGoal(goalsInSpace, selectedGoalIds[activeSpace])?.id ?? null}
                onSelectGoal={(id) =>
                  setSelectedGoalIds((previous) => ({ ...previous, [activeSpace]: id }))
                }
                planning={planning}
                planError={planError}
                planResult={planResult}
                onBuildPlan={handleBuildPlan}
                onTrackFromPreview={trackFromPreview}
                onAskAdviser={handleAskAdviser}
                focusComposerSignal={composerFocusSignal}
                onDeleteGoal={deleteGoal}
                onLogSavings={logSavings}
                onDeleteLog={deleteLog}
                onNavigate={setView}
              />
            </div>
          ) : view === 'goals' ? (
            <div className="view-panel stack" id="view-goals">
              <div className="view-head">
                <h1 className="view-title">Goals</h1>
              </div>
              {sampleIntroVisible ? (
                <SampleIntroCard onDismiss={() => setSampleIntroVisible(false)} />
              ) : null}
              <PlannerTab
                space={activeSpace}
                householdProfile={activeProfile}
                prompt={prompt}
                onPromptChange={setPrompt}
                planning={planning}
                planError={planError}
                planResult={planResult}
                onPlan={handlePlan}
                onTrackGoal={trackCurrentGoal}
                connection={status === null ? null : status.connection}
                onApplyRevision={applyAdvisorRevision}
                onTakeHomeCommit={commitTakeHome}
                focusPromptSignal={focusPromptSignal}
              />
              <DashboardTab
                space={activeSpace}
                goals={goalsInSpace}
                profile={activeProfile}
                monthKey={monthKey}
                onDeleteGoal={deleteGoal}
                onLogSavings={logSavings}
                onDeleteLog={deleteLog}
                onNavigate={setView}
              />
            </div>
          ) : view === 'adviser' ? (
            <div className="view-panel stack" id="view-adviser">
              <div className="view-head">
                <h1 className="view-title">Adviser</h1>
              </div>
              <AdviserTab
                space={activeSpace}
                profile={activeProfile}
                ledger={ledgers[activeSpace]}
                goals={goalsInSpace}
                walletNames={wallets[activeSpace].map(
                  (id) => allCards.find((card) => card.id === id)?.name ?? id
                )}
                protectedCategories={adviserProtected[activeSpace]}
                onToggleProtected={toggleAdviserProtected}
                onProtect={protectAdviserCategory}
                transcript={adviserTranscripts[activeSpace]}
                modelCallsUsed={adviserModelCalls[activeSpace]}
                onTurnComplete={appendAdviserExchange}
                onModelCalls={noteAdviserModelCalls}
                onUpdateProfileField={updateProfileField}
                onReviseGoal={reviseAdviserGoal}
                onCaptureUndo={captureAdviserUndo}
                onUndo={undoAdviser}
                undoAvailable={adviserUndo[activeSpace] !== undefined}
                connection={status === null ? null : status.connection}
                initialQuestion={adviserInitialQuestion ?? undefined}
                onInitialQuestionConsumed={() => setAdviserInitialQuestion(null)}
                selectedGoalId={pickSelectedGoal(goalsInSpace, selectedGoalIds[activeSpace])?.id ?? null}
              />
            </div>
          ) : (
            <div className="view-panel stack" id="view-cards">
              <div className="view-head">
                <h1 className="view-title">Cards</h1>
              </div>
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
            <p className="reading">
              Educational hackathon demo, not financial advice. Duty tables, loan caps and card
              terms are illustrative snapshots that must be verified against IRAS, MAS, CPF and
              the issuers.
            </p>
            <p className="source-note reading">
              Export writes every SpendWise key in this browser to a spendwise-backup.json file.
              Import validates the file first and only restores keys that pass the app&rsquo;s own
              shape checks, so a tampered or partial backup never corrupts your data. The sample
              journey asks before it overwrites anything.
            </p>
          </footer>
        </main>
      </div>

      <ProfileDrawer
        open={profileDrawerOpen}
        onClose={() => setProfileDrawerOpen(false)}
        space={activeSpace}
        profileForm={profileForms[activeSpace === 'partner' ? 'partner' : 'you']}
        onProfileField={updateProfileField}
        householdProfile={activeProfile}
      />

      {/* Visually hidden but still focusable file input behind the Import action. */}
      <input
        ref={fileInputRef}
        className="footer-file"
        type="file"
        accept="application/json,.json"
        aria-label="Import a SpendWise backup file"
        onChange={onImportFileChange}
      />
    </div>
  );
}

/** The four-step guide card shown right after the sample journey is seeded. */
function SampleIntroCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section className="card journey-intro" aria-label="Sample journey guide">
      <div className="card-title-row">
        <h2 className="card-title">Sample journey, in four steps</h2>
        <button type="button" className="btn btn-ghost btn-small" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <ol className="action-list">
        <li>
          <span className="strong">Set your numbers.</span> The journey seeded both personal
          profiles, their wallets and this tracked Us goal. Open You and Partner to adjust income,
          savings and CPF.
        </li>
        <li>
          <span className="strong">Ask the advisor.</span> In the Goals view, ask a what-if such
          as &ldquo;what if my partner stops working for 6 months?&rdquo; and apply or keep each
          revision.
        </li>
        <li>
          <span className="strong">Log a month each.</span> The seeded goal already carries three
          months of savings from both contributors. Log this month in the Us space to keep the
          trajectory honest.
        </li>
        <li>
          <span className="strong">Export your data.</span> The Export data action in the sidebar
          (or the More sheet on mobile) writes every SpendWise key to a backup JSON you can import
          in any browser.
        </li>
      </ol>
    </section>
  );
}
