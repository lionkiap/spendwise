# SpendWise

Tell SpendWise your money goal in plain English and it compiles the prompt into a full deterministic plan, then routes every card purchase in your wallet, including cards you add yourself, to the best reward. A what-if advisor sits under every plan: ask "what if my partner stops working for 6 months?", watch the deterministic kernels re-run before and after, then apply the revision or keep it as a reference. A switcher in the masthead moves between You, Partner and Us spaces, so the same engines plan for one person or a couple, and the footer exports and imports everything you saved as a validated backup file.

## What it is and why

SpendWise is two tools in one Next.js app, built for the NVIDIA Nemotron on Nebius Token Factory track (Best Apps and Agents):

1. **A prompt-driven financial goal compiler.** You type "I want to buy a HDB worth about 600k by age 28". Nemotron Super parses that sentence into a validated GoalSpec. Snapshot assumptions fill whatever the prompt left unstated and pure TypeScript kernels compute the whole plan: the upfront cost stack with buyer stamp duty, the required monthly saving, the savings schedule, MSR and TDSR debt checks, a nine-cell what-if grid, milestones and teaching points. The verdict measures affordability against a spendable surplus: take-home pay you state directly, or gross pay minus the employee CPF contribution of 20 percent up to the S$6,000 ordinary-wage ceiling, minus expenses and monthly debt repayments, while MSR and TDSR stay on gross income (`src/lib/planner/build.ts:332`, `src/lib/kernels/cpf.ts:71`). An optional investment portfolio is credited toward the goal first and grows at its own rate, and car goals add a total cost of ownership block. Under the rendered plan a what-if advisor answers questions about it: Nemotron Super classifies the ask, a pure engine applies the revision, both plans are rebuilt through the same kernels and the comparison sentence is composed only from those kernel numbers (`src/app/api/advisor/route.ts:146`). Nemotron Ultra may then rewrite the verdict reasoning and teaching bodies, and a badge says which engine wrote the words. The LLM parses language, classifies intent and rewords narrative; it never computes a number.
2. **A credit card maximizer.** In the browser, with zero model calls for every routing and audit figure, a deterministic engine ranks your wallet for each expense against bonus tiers, monthly caps, minimum spends and a miles valuation you control. Add your own cards from your statement and the engine scores them exactly like the built-ins. A wallet audit then replays your logged month against an always-optimal chooser and shows exactly how much reward was left on the table, purchase by purchase, with an optional Nemotron Ultra rephrasing of each miss behind a button.

Both tools now sit on a couples layer. A switcher in the masthead selects You, Partner or Us (`src/app/components/header.tsx:82`). You and Partner each own a profile, wallet and expense ledger under their own storage keys, and Us carries a shared wallet and ledger and plans on the two personal profiles combined (`src/lib/planner/goalspec.ts:141`). A one-time migration copies the pre-couples storage keys into the You space and leaves the originals in place, never deleting them (`src/app/components/shared.ts:468`), so a single user wakes up in exactly the app they had.

We built it this way because a financial tool that lets a language model do arithmetic is a tool that can be confidently wrong. Here every figure traces to a pure, tested function and every model output passes a zod gate before anything downstream sees it.

## Features

**Goal Planner**

- Plain English goals in three shapes: savings target, property purchase (HDB resale, BTO or condo) and car purchase (`src/lib/planner/goalspec.ts`)
- Nemotron parsing with one corrective retry, always validated by a zod discriminated union before use (`src/lib/planner/parse.ts:56`)
- A local regex fallback parser so the planner works with no API key and no network (`src/lib/planner/parse.ts:217`)
- Investments as a planner input: the optional Investments and Expected return fields in the Your profile card on the Goal Planner tab (`src/app/components/planner-tab.tsx:190`) credit an existing portfolio toward the goal first, compounding at its own rate, so the required monthly saving drops by the projected future value (`src/lib/planner/goalspec.ts:87`)
- Spendable-income affordability: three optional profile fields (Take-home income, Monthly debt repayments, Emergency fund at `src/app/components/planner-tab.tsx:214`) shape the verdict. The surplus is stated take-home pay, or gross minus the employee CPF contribution of 20 percent up to the S$6,000 ordinary-wage ceiling when no take-home is stated, minus expenses and monthly debt repayments; the headline and reasoning name exactly which deductions bit (`src/lib/planner/build.ts:332`, `src/lib/kernels/cpf.ts:71`). MSR and TDSR checks keep measuring against gross income because that is what the rules use (`src/lib/planner/build.ts:641`), and a teaching sentence advises holding an emergency reserve of months of expenses before locking money in, advisory text that never changes the savings math (`src/lib/planner/build.ts:494`)
- Assumption chips that name every number the prompt left out and why it was filled, including six snapshot defaults such as the 4 percent stress rate, 2.5 percent inflation and the 4.5 percent investment growth rate that appears only when a portfolio exists and its rate is unstated. Each chip carries a friendly label (Savings growth rate, Mortgage stress-test rate, Target age and so on) with the raw field name kept as the hover title (`src/app/components/shared.ts:227`, rendered at `src/app/components/plan-view.tsx:317`)
- A savings schedule whose interest column is growth only: the year-zero baseline is the whole starting pot of cash plus investments, so the first year never reports money you already held as interest (`src/lib/planner/build.ts:224`)
- Upfront cost stack: BSD by marginal tiers, ABSD by citizenship and property count, the 5 percent minimum cash leg of the down payment, legal fee estimates and a renovation buffer for resale flats (`src/lib/kernels/property.ts`)
- Mortgage check at the 2.6 percent concessionary rate plus a 4 percent stress test, with MSR (30 percent) and TDSR (55 percent) pass and fail pills
- CPF OA projection at the 2.5 percent floor rate and the opportunity cost of drawing CPF down (`src/lib/kernels/cpf.ts`)
- Total cost of ownership for car goals: per-year financing, insurance, road tax, energy and maintenance plus the horizon total, every figure from the `tcoCompare` kernel with each input exposed as a readable assumption line (`src/lib/planner/build.ts:757`)
- A nine-cell scenario grid: rate down 1 point, as-is and up 1 point, crossed with saving 20 percent less, as planned and 20 percent more
- Milestone timeline and teaching points: compounding, inflation-adjusted real value, CPF opportunity cost, rate sensitivity
- A Nemotron Ultra narrative pass that rewrites only the verdict reasoning and teaching bodies of the already computed plan, behind two code-enforced gates: a shape gate (nonempty strings, exactly one body per teaching point) and a figure gate (every dollar amount, percentage and standalone age the model writes must match a figure the deterministic plan already contains, within a 0.5 percent tolerance) so an invented figure can never reach the screen. Any failure returns the plan unchanged with a visible engine badge and a deterministic fallback (`src/lib/planner/narrative.ts:230`, figure extraction at `src/lib/planner/narrative.ts:65`, the allowed set at `src/lib/planner/narrative.ts:164`)
- A header status pill with three honest states: Local mode (no key), Key set, connection unverified (a key exists but the live health check did not complete within 2.5 seconds) and Nemotron connected (a real chat call on the nano model returned parsable JSON). One `/api/status` fetch feeds both the pill and the advisor's engine badge, and the API key never leaves the server (`src/app/api/status/route.ts:32`, `src/lib/nebius.ts:65`, `src/app/components/header.tsx:41`)

**What-if advisor**

The advisor is the conversation under the rendered plan (`src/app/components/advisor-card.tsx:71`). Every turn posts the whole transcript plus the current goal spec and planning profile to `/api/advisor` and renders one of three reply shapes:

- Ask: Nemotron Super classifies the turn into clarify (a needed number is missing, so it asks numbered questions), revise or answer, behind a zod discriminated union with one corrective retry (`src/lib/advisor/classify.ts:121`). Unconfigured, failing or malformed replies all land on the deterministic regex classifier, which understands a fixed set of shapes (a stretch without income, a delayed deadline, a cheaper goal) and says so honestly when it cannot parse you (`src/lib/advisor/engine.ts:205`)
- Revise: the pure `applyRevision` applies the patch immutably. Numeric fields edit only the field the goal kind actually carries (a price field on the wrong goal kind is ignored and the note says so), and an income gap is modelled deterministically as a runway burn on liquid savings, plainly labelled an approximation (`src/lib/advisor/engine.ts:58`)
- Compare: the before and after plans are both built by `buildPlan` with `fillAssumptions`, and the comparison sentence is composed only from those kernel-computed numbers (required monthly, verdict, target). The model never supplies a number on this path (`src/app/api/advisor/route.ts:178`, the sentence builder at `src/app/api/advisor/route.ts:123`)
- Apply or keep: Apply stores the revised goal spec and profile into the planner state and rebuilds the plan right in the browser with the same `buildPlan`, so it needs no second network call; Keep leaves the block as a read-only reference (`src/app/page.tsx:617`). In a personal space the revised profile also lands in that person's form; in Us the card notes that per-person edits belong in the You and Partner spaces
- Works offline end to end: with no key the fallback classifier fields every question and the badge reads Offline advisor; with a key it reads Advisor by Nemotron or Advisor, Nemotron unverified, fed by the same `/api/status` truth as the header pill (`src/app/components/advisor-card.tsx:164`)
- Starter chips for the demo: "Can we afford this flat?", "What if my partner stops working for 6 months?" and "What if we buy 2 years later?" (`src/app/components/advisor-card.tsx:47`)

**Data care**

- Export data writes every `sw_` storage key into a downloadable `spendwise-backup` JSON with a versioned header; Import data validates each key against the existing guards and writes only what validates, reporting what it skipped (`src/app/components/shared.ts` buildBackup and parseBackup, tested in `src/tests/app-integration.test.ts`)
- Try the sample journey seeds a realistic demo state (a partner profile, both wallets, a tracked Us goal with three months of logs across both contributors) through a pure builder, confirms before overwriting existing data, then lands you on the Us Progress tab with a dismissible four-step intro card (`src/app/components/shared.ts` buildSampleJourney)

**Card Maximizer**

- 14 illustrative Singapore cards (8 cashback, 6 miles) in `src/lib/data/cards.ts`, each carrying a `sourceNote` disclaimer, plus any cards you add yourself
- Custom cards: a zod-validated form parses name, issuer, reward type, base rate, up to eight bonus tiers, optional minimum spend and annual fee, sanity checks the rates (cashback between 0 and 20 percent, miles between 0.5 and 10 per dollar), slugs the id and forces the fixed user-entry disclaimer, then merges the saved deck after the built-ins with collision-safe ids (`src/lib/cards/custom.ts:201`, `src/lib/cards/custom.ts:255`)
- Best-card ranking per expense that honors category bonus tiers, monthly caps reduced by spend already logged, minimum-spend gating and miles valuation (`src/lib/cards/engine.ts:222`)
- A human-readable `mathTrace` for every recommendation showing the rate, cap headroom, overflow and reward arithmetic
- A miles valuation slider (1.4 to 2.4 SGD cents per mile) that can flip a ranking live
- Minimum spend progress and top category cap usage bars for the current month
- A wallet audit that replays the month twice (actual versus always-optimal) and reports what was left on the table with a "why" per miss (`src/lib/cards/engine.ts:264`)
- A ledger manager with per-row delete, clear month and a one-click realistic sample month so the audit can be demoed cold (`src/app/components/ledger-manager.tsx:45`)
- An optional Explain misses button that posts the deterministic misses to `/api/audit/explain` for a Nemotron Ultra rephrasing, one call per press, with the deterministic why text standing in whenever the key is missing or the reply is unusable (`src/app/components/cards-tab.tsx:551`)
- Profile, wallet, ledger and custom cards persist in localStorage: one profile per person and one wallet and ledger per space, plus the shared custom card deck. The Us profile is never stored; it is derived by `combineProfiles` on every render. See the Local storage section for the full key map and the one-time migration

**Couples spaces**

- Three spaces switched from the masthead: You, Partner and Us, a radiogroup under the tabs (`src/app/components/header.tsx:96`), with the active space persisted in `sw_space_active` (`src/app/page.tsx:296`)
- You and Partner each carry their own profile form, wallet and expense ledger under their own storage keys (`src/app/page.tsx:133`, `src/app/page.tsx:147`). The prompt stays shared across spaces; switching clears the plan on screen so figures from another space's profile never linger, and the Plan button stays the only replan trigger. The next press sends the same sentence with the new space's profile (`src/app/page.tsx:131`)
- The Us space plans on the combined household profile: `combineProfiles` sums income, expenses, liquid savings, CPF OA and investments; age and the miles valuation stay anchored on the primary profile, and the investment rate comes from the primary when set (else the partner's) (`src/lib/planner/goalspec.ts:114`), shown as a read-only Household card in the planner that always reflects the sum (`src/app/components/planner-tab.tsx:53`)
- Us carries a shared wallet and ledger, and cards in it that already sit in a personal wallet wear their owner's Y or P badge (`src/app/page.tsx:326`, `src/app/components/cards-tab.tsx:286`; You wins a tie, mirroring how the combined profile anchors on the primary person)
- Goals tracked from a space are tagged with it (`src/app/page.tsx:456`) and the dashboard filters by it (`src/app/page.tsx:583`). Ids only collide within a space, so tracking the same HDB sentence in You and then in Us creates two independent goals, each with its own baseline and logs, and re-tracking inside one space re-baselines that space's copy (`src/app/page.tsx:464`)
- Us goals log savings per contributor through the Logged by toggle (`src/app/components/dashboard-tab.tsx:398`). The toggle starts on You for a new log (`src/app/components/dashboard-tab.tsx:267`); a month holds one log, so saving the same month again replaces that month's log, which is also how you correct a wrong contributor (`src/app/page.tsx:493`), and each row in the log table carries a Remove button that deletes that month's log (`src/app/components/dashboard-tab.tsx:450`)
- The saved-so-far figure splits into raw you and partner totals, where raw means the plain sum of each contributor's logged amounts with no interest applied, counting only logs dated inside the elapsed window (`src/lib/planner/progress.ts:277`, `src/app/components/dashboard-tab.tsx:325`)
- Once the partner has logged any month, the trajectory chart replaces the single actual line with two per-contributor lines. The pot is the goal's `startSavingsSgd`: the active space's liquid savings frozen at the moment Track was pressed, so for a Us goal it is the combined household savings (`src/app/page.tsx:453`). Each line is that pot grown at the plan's rate plus only that person's logged contributions, each grown from its own month; the combined actual balance is `actualBalance`, the same pot grown plus every log from both people (`src/lib/planner/progress.ts:313`, `src/lib/planner/progress.ts:139`). The invariant therefore reads: you line plus partner line minus the grown pot equals the combined actual balance at every sampled month (`src/lib/planner/progress.ts:355`, `src/app/components/dashboard-tab.tsx:562`, pinned by tests in `src/tests/spaces.test.ts`)
- Existing data migrates once: the pre-couples keys copy into the You space and `sw_goals` is tagged in place, nothing deleted (`src/app/components/shared.ts:374`)
- The whole layer adds zero model calls: profile combination, the contributor split and both chart series are pure functions

## Architecture

```
        prompt: "buy a HDB worth 600k by age 28"          profile form
                                                          (of the active space)
                          |                                     |
                          v                                     v
        +-----------------------------+   +-------------------------------+
        |  POST /api/plan (Next.js)   |   | Nemotron Super on Nebius      |
        |  zod request validation     |-->| Token Factory                 |
        |                             |   | (OpenAI-compatible endpoint,  |
        +-----------------------------+   |  temperature 0, JSON mode)    |
                          |               +-------------------------------+
          GoalSpec        |  zod-validated; on any failure the local
          (discriminated  |  regex parser in parse.ts takes over
           union)         v
        missingFields -> fillAssumptions (snapshot defaults, named chips)
                          |
                          v
        +-------------------------------------------------------+
        | deterministic kernels (src/lib/kernels)               |
        |  tvom:     fvLump fvAnnuity pmtForFv rateForFv        |
        |            amortize realValue                         |
        |  property: bsd absd downPaymentSplit msr tdsr legal   |
        |  cpf:      oaProjection opportunityCostOfCpf          |
        |  car:      carLoanLimits flatToEffective tcoCompare   |
        +-------------------------------------------------------+
                          |
                          v
              PlanJSON (narrativeEngine: deterministic)
                          |
                          v
        +-----------------------------+   +-------------------------------+
        | enrichPlanNarrative         |-->| Nemotron Ultra on Nebius      |
        | rewrites verdict.reasoning  |   | Token Factory                 |
        | and the teaching bodies     |   +-------------------------------+
        | only; figures are copied    |
        | verbatim, never recomputed  |  on any failure (no key, a null
        +-----------------------------+  reply, an invalid shape) the plan
                          |             returns unchanged with
                          v             narrativeEngine 'deterministic'
                       PlanJSON -> verdict, three actions, required
                       monthly saving, cost stack, schedule, debt
                       check, scenario grid, milestones, teaching,
                       tco (car goals), parser and engine badges

 Card Maximizer tab (client side; routing and audit math are zero-call)
 ---------------------------------------------------------------------
   sw_custom_cards -> parseCustomCard (zod, rates sanity checked,
   forced user-entry sourceNote) -> mergeCards(CARDS, custom)
        |
        v
   wallet + ledger (localStorage, month-tagged entries, per-row
   delete, clear month, load sample month)
        |                    |
        v                    v
   routeExpense         walletAudit
   ranks the merged     replays the month: actual cards vs an
   deck for one         always-optimal chooser; reports
   expense with caps,   leftOnTableSgd and a why per miss
   minimum spends              |
   and miles                   v  (button press only, optional)
   valuation         POST /api/audit/explain -> Nemotron Ultra
                     rephrases each miss; any failure answers
                     engine "deterministic" and the client keeps
                     the engine's own why text

 Spaces (masthead switcher under the tabs: You | Partner | Us)
 ---------------------------------------------------------------------
   you: own profile form,      partner: own profile form,
        wallet and ledger           wallet and ledger
          |                              |
          +--------------+-------------+
                         v
   us: read-only Household profile = combineProfiles(you, partner)
       (income, expenses, savings, CPF OA and investments summed;
        age and miles valuation anchored on you; investment rate
        from you when set, else the partner's)
       plus a shared wallet and ledger, where cards already in a
       personal wallet wear their owner's Y or P badge
                         |
                         v
   Progress tab: each tracked goal carries a space tag and the
   dashboard filters by it. Us goals log savings per contributor
   (the Logged by toggle) and split the saved-so-far figure into
   you and partner totals; once the partner has logged anything
   the chart draws two actual lines, pot + you and pot + partner.

   On hydrate migrateLegacyStorage copies the pre-couples sw_profile,
   sw_wallet and sw_ledger into the you space once (legacy keys kept,
   nothing deleted) and tags sw_goals in place, so a pre-couples user
   lands in You with everything intact.

 GET /api/status -> { nebiusConfigured, models } -> header pill
 (Local mode vs Nemotron connected; reads env only, the key never
  leaves the server)
```

Every arrow into the plan passes through a pure function. The model is touched in exactly three places: the Super call that parses the prompt, the Ultra call that rewords the plan narrative and the optional Ultra call behind the audit explain button. Everything else, including all card routing and all audit arithmetic, runs locally. The spaces layer adds no new arrows into the model: the combined household profile is pure addition (`combineProfiles`, `src/lib/planner/goalspec.ts:114`) and the contributor split plus both chart lines come from pure functions in `src/lib/planner/progress.ts`, so planning in Us costs exactly what planning in You costs.

## Local storage

Everything SpendWise remembers lives in one browser's localStorage, hydrated inside effects so server prerender and client hydration agree, and every key stayed backward compatible across the spaces feature:

| Key | What it holds |
|-----|---------------|
| `sw_space_active` | which space is active: `you`, `partner` or `us` |
| `sw_profile_you` | your profile, the numbers behind the You profile form |
| `sw_profile_partner` | the partner profile |
| `sw_wallet_you` | your wallet: card ids into the merged deck of built-in and custom cards |
| `sw_wallet_partner` | the partner wallet |
| `sw_wallet_us` | the shared Us wallet |
| `sw_ledger_you` | your month-tagged expense entries |
| `sw_ledger_partner` | the partner ledger |
| `sw_ledger_us` | the shared Us ledger |
| `sw_custom_cards` | your saved custom cards, shared across all spaces |
| `sw_goals` | the tracked goals with their savings logs; each goal carries its own `space` tag and each log its `contributor` |

**Migration of existing data.** On the first load after the spaces feature, `migrateLegacyStorage` (`src/app/components/shared.ts:374`, called first in the hydrate effect at `src/app/page.tsx:167`) copies the pre-couples `sw_profile`, `sw_wallet` and `sw_ledger` into `sw_profile_you`, `sw_wallet_you` and `sw_ledger_you` whenever those successors do not exist yet, then rewrites `sw_goals` in place adding `space: 'you'` to goals that lack the field and `contributor: 'you'` to logs that lack one. Existing data lands in the You space untouched: the legacy keys are kept as read-only inputs, never deleted, existing per-space keys are never overwritten and the second run is a no-op (`src/tests/spaces-ui.test.ts`).

## How we use NVIDIA Nemotron

SpendWise talks to Nebius Token Factory through the official `openai` SDK pointed at the OpenAI-compatible endpoint (`https://api.tokenfactory.nebius.com/v1`, override with `NEBIUS_BASE_URL`). The wrapper in `src/lib/nebius.ts` asks for strict JSON with `response_format: json_object` at temperature 0, strips markdown fences and reasoning prefixes from the reply and fails soft to null so the app can fall back offline.

Three model roles, each an environment-configurable id (see `.env.example`). The default ids are illustrative: both `.env.example` and `src/lib/nebius.ts` say so and point to the Nebius Token Factory model catalog (https://docs.tokenfactory.nebius.com/). Check them there before relying on them, and note that this check has not been done or recorded yet: PROJECT_DESCRIPTION.md's Submission artifacts section carries the unchecked "Model ids verified" box. Until that box is ticked, a wrong id would fail soft into Local mode with the local fallback parser, so the demo degrades silently rather than crashing and the header pill (`src/app/components/header.tsx:41`) is the signal to check before trusting a Nemotron badge. Any role can be swapped by env with no code change:

| Role  | Default id in .env.example                        | Job in SpendWise |
|-------|---------------------------------------------------|------------------|
| Ultra | `nvidia/llama-3.1-nemotron-ultra-253b-v1`         | Live in two call sites, both about words rather than numbers: rewriting the plan narrative (verdict reasoning and teaching bodies, `src/lib/planner/narrative.ts:26`) and rephrasing wallet audit misses (`src/lib/cards/explain.ts:86`). Both degrade to deterministic output. |
| Super | `nvidia/llama-3.3-nemotron-super-49b-v1.5`        | The GoalSpec parser. `superModel()` is the model on the wire in `src/lib/planner/parse.ts:62`. |
| Nano  | `nvidia/nemotron-nano-9b-v2`                      | Reserved for fast chat on the happy path, where a small model keeps latency and tokens low. |

Override any role without touching code:

```
NEMOTRON_ULTRA_MODEL=...
NEMOTRON_SUPER_MODEL=...
NEMOTRON_NANO_MODEL=...
```

Honest note: two roles are wired into the running pipeline today. Super parses the prompt into a GoalSpec (`src/lib/planner/parse.ts:62`, called from `src/app/api/plan/route.ts:110`). Ultra writes the words in two places: the plan narrative pass (`src/lib/planner/narrative.ts:89`, called from `src/app/api/plan/route.ts:124`) and the audit explanation endpoint (`src/lib/cards/explain.ts:86`, called from `src/app/api/audit/explain/route.ts:69`). Both Ultra call sites validate the reply shape before trusting it and return deterministic output when Nebius is unconfigured, unreachable or wrong, so the app runs fully offline with no key. Nano remains an env-configurable slot awaiting its call site.

## Credits strategy: minimal tokens by design

Deterministic kernels keep token usage minimal:

- **One Super call for parsing plus one Ultra call for narrative per plan.** The happy path is two chat completions: Super parses the prompt into a GoalSpec and Ultra rewords the verdict reasoning and teaching bodies of the plan those kernels already produced. Two retries can stack on the parse: the corrective retry in `src/lib/planner/parse.ts:68` when a reply fails zod validation and the wrapper's own retry without `response_format` in `src/lib/nebius.ts:119` when the endpoint rejects that option. The narrative pass has no corrective retry; an unusable reply simply keeps the deterministic text. So the theoretical worst case per plan is six completions (four from the parse path, two from the narrative), and everything after the GoalSpec is arithmetic the narrative only ever rewords. One transport caveat for anyone counting requests rather than completions: the OpenAI client is built with `maxRetries: 1` (`src/lib/nebius.ts:52`), which can re-issue each of those completions once at the HTTP level, putting the absolute ceiling at twelve requests on the wire per plan.
- **Zero calls for what-if changes.** The nine-cell scenario grid is recomputed locally from `pmtForFv` on every plan. Dragging the miles valuation slider reranks the wallet instantly with no round trip.
- **Zero calls for card routing and the audit math.** The entire Card Maximizer tab, including custom card validation, the merged deck, the routing engine and the wallet audit replay, runs in the browser. The audit's dollars-left-on-the-table figure is computed before any model is consulted. The one optional exception is the Explain misses button: one Ultra call per press, never automatic (`src/app/components/cards-tab.tsx:197`). You can still demo the whole tab on a plane; the button just answers deterministic without a key.

Planning in the Us space counts the same as any other plan: the combined household profile is computed in the browser by `combineProfiles` and posted in place of a personal one, so the happy path stays at two completions.

## Setup

Requirements: Node 18 or later (Next.js 14 needs 18.17 or newer) and npm.

```
npm install
cp .env.example .env.local
# add your NEBIUS_API_KEY from the Nebius Token Factory console
npm run dev
```

Then open http://localhost:3000.

Filename note: the header inside `.env.example` says "Copy to .env" while the command above uses `.env.local`. Next.js loads either and this repo's `.gitignore` excludes both with its first three patterns, `.env`, `.env.local` and `.env.*.local` (`.gitignore:3` to `.gitignore:5`). There is no blanket `.env*` pattern, so an unusually named file such as `.env.foo` would not be ignored; pick one of the covered names and stay with it.

**No key? It still works.** Without `NEBIUS_API_KEY` the app detects that Nebius is unconfigured and every model-touching path degrades: the local regex parser takes over the prompt, the narrative pass returns the deterministic plan with `narrativeEngine: 'deterministic'` and the explain endpoint answers deterministic so the client keeps the engine's own why text. Both tabs remain fully functional for demos. The header pill reads `/api/status` and shows Local mode versus Nemotron connected (`src/app/components/header.tsx:41`), the plan carries the parser badge ("Parsed by Nemotron on Nebius" versus "Parsed by the local fallback parser") and the teaching section carries the engine badge ("Explanations by Nemotron Ultra" versus "Deterministic explanations", `src/app/components/plan-view.tsx:295`). The route attributes the parser conservatively by re-running the offline parser as a witness (`src/app/api/plan/route.ts:72`).

Run the tests:

```
npm test
```

## Deploying with Nebius Serverless Endpoints (optional)

The app is a standard Next.js deployment plus one secret. To serve the models from Nebius Serverless Endpoints instead of the shared Token Factory API:

1. Deploy or select your Nemotron model on a Nebius serverless endpoint and copy its base URL.
2. Set `NEBIUS_BASE_URL` in your hosting provider's environment to that endpoint's OpenAI-compatible URL and keep `NEBIUS_API_KEY` set there too. No code change is needed because the client is built from env at call time.
3. Deploy the Next.js app anywhere Node 18 runs (`npm run build` then `npm start`) or to a platform that runs the build for you. Only `/api/plan` and `/api/audit/explain` touch the model; `/api/status` reads environment configuration only. Splitting the frontend from a separately hosted API would need a small code change first: the client calls the hard-coded relative paths `fetch('/api/plan')` in `src/app/page.tsx:520` and `fetch('/api/audit/explain')` in `src/app/components/cards-tab.tsx:207`, and no public API base URL is configurable in `src/` today.

## Demo video script (four beats)

Record these beats and link the video, plus a hosted demo URL, from PROJECT_DESCRIPTION.md before submitting; its Submission artifacts section is the pre-submission checklist and none of its boxes is checked yet: the video, the hosted URL, the screenshots, the team contact, the model id verification against the catalog and the track requirements verification against the current track page. Do not submit until every box there is checked. The Deploying section below is the path to producing the hosted URL, and the Setup section above is the run-it-yourself fallback until it exists.

1. **The plan (about 60 seconds).** Point at the header status pill first so viewers know whether Nemotron is connected. Type "I want to buy a HDB worth about 600k by age 28" with the default profile, then enter 20000 in the "Investments (S$, optional)" field of the Your profile card at the top of the Goal Planner tab (`src/app/components/planner-tab.tsx:145`) and press Plan again to show the required monthly saving drop and the 4.5 percent investment growth chip appear. Walk the result top to bottom: the verdict hero, the three actions, the cost stack and its BSD row (S$12,600, from the first three marginal tiers, which match the IRAS schedule), the MSR and TDSR pills, the savings schedule and the scenario grid. Close on the parser badge and the engine badge on the teaching section saying who parsed and who wrote the words.
2. **The wallet (about 75 seconds).** Switch to Card Maximizer. Pick a wallet, enter a S$120 dining expense and show the ranked list with a math trace. Slide the miles valuation to flip the winner. Click "Add your own card", enter a card with a dining tier that beats the whole deck and route the same S$120 again: the custom card wins, carries the Custom badge and shows its "User-entered terms. Not verified against any issuer." sourceNote. Click "Load sample month", show the audit: what the month earned versus the optimal chooser and the exact dollars left on the table with the why. Then press "Explain misses with Nemotron" and show the Ultra rephrasing appear under each miss (or the Local mode note when no key is set).
3. **The couple (about 60 seconds).** Switch the masthead space switcher to Us. The planner swaps the editable profile card for the read-only Household card with the two profiles summed (`src/app/components/planner-tab.tsx:53`); its note tells you to edit each person's numbers in their own space, because the card always shows the sum. With the same prompt as beat one still in the box, point out that the plan on screen still shows the You-space figures (switching does not replan by itself), then press Plan and show the required monthly saving drop, because the replan now runs on the combined household profile (`src/app/page.tsx:240`). Press Track this goal so the goal is tagged space 'us'. On the Progress tab log one month with Logged by You and another with Logged by Partner, the toggle that only appears on Us goals (`src/app/components/dashboard-tab.tsx:398`). The chart replaces the single actual line with two, pot plus you and pot plus partner, both starting from the same pot (`src/app/components/dashboard-tab.tsx:562`), and the saved-so-far figure splits into you and partner totals (`src/app/components/dashboard-tab.tsx:325`). Close on the Us wallet in Card Maximizer, where cards already in a personal wallet carry their owner's Y or P badge (`src/app/components/cards-tab.tsx:286`).
4. **The architecture (about 30 seconds).** Show `.env.local` with no API key, replan and land on the local fallback parser with the same plan, the teaching badge reading "Deterministic explanations" and the header pill reading Local mode. Close on the point: one Super call to parse plus one Ultra call to narrate per plan on the happy path, zero calls for what-ifs, card routing and the audit math, every number from a tested pure function.

## Disclaimers

- **Card terms are illustrative.** All 14 cards in `src/lib/data/cards.ts` are published-style simplifications as of 2025. Rates, caps, minimum spends and exclusions change constantly and each card carries a `sourceNote` saying so. Verify every term with the issuer before relying on it.
- **Custom cards are user-entered and unverified.** Every card you add yourself is forced to carry the fixed sourceNote "User-entered terms. Not verified against any issuer." (`src/lib/cards/custom.ts:16`). The form sanity checks ranges (cashback between 0 and 20 percent, miles between 0.5 and 10 per dollar, at most eight tiers) but nothing cross-checks your terms against a real issuer, so a mistyped cap or rate routes confidently wrong until you fix it.
- **Investment growth is an assumption.** When you state a portfolio but no rate, the planner assumes 4.5 percent a year and shows a chip saying so (`src/lib/planner/goalspec.ts:27`). The projection is a smooth compounding curve with no volatility, sequence risk, fees or taxes; it is a planning aid, not a forecast.
- **Duty tables and lending rules are snapshots.** The statutory residential BSD schedule in force since 15 Feb 2023 runs 1 percent of the first 180k, 2 percent of the next 180k, 3 percent of the next 640k, 4 percent of the next 500k up to 1.5m, 5 percent of the next 1.5m up to 3m and 6 percent only above 3m. The tier table in `src/lib/kernels/property.ts` matches that statute exactly and produces S$12,600 on a 600k purchase. The car financing caps in `src/lib/kernels/car.ts` follow the MAS rules for motor vehicle loans: 70 percent LTV with a 7 year tenor at OMV up to 20k, 60 percent LTV with a 5 year tenor above that. ABSD rates, the property LTV frame, MSR and TDSR limits and CPF rates remain hackathon snapshots. Re-verify everything against IRAS, MAS, CPF and LTA before production or advisory use.
- **This is not financial advice.** SpendWise is an educational hackathon demo. Nothing it outputs is a recommendation to buy any property, car, card or instrument.

## Known limitations

- **No accounts or server-side storage.** Every profile, wallet, ledger, custom card deck and tracked goal lives in one browser's localStorage and is gone if you clear it.
- **Spaces are a local-device concept until accounts exist.** You, Partner and Us are three sets of keys in the same browser's localStorage, not two people's accounts: there is no sign-in, sync or sharing, and nothing authenticates a partner's numbers. Until accounts exist, whoever holds the device edits both people.
- **localStorage persistence only, with export and import as the safety net.** Nothing syncs across devices, but the footer exports every `sw_` key to a validated backup file and imports it back, skipping any key that fails its guard rather than rejecting the whole file.
- **Heuristic fallback parser.** The offline parser is regex-based. It handles the documented prompt shapes (age deadlines, "in N years", k/m/mil/million amounts, percent rates) but not free-form phrasing. It silently returns a sentinel-zero amount when it cannot find a number, which the plan then surfaces as a missing field. The Nemotron path handles broader phrasing but needs a key.
- **User-entered card terms are unverified.** A custom card is scored by the same engine as the built-ins, which is the point and also the risk: nothing validates your entered cap, rate or minimum spend against the issuer. The forced disclaimer and range checks are the only guards.
- **Investments grow at an assumed rate.** The portfolio leg compounds at your stated rate or the 4.5 percent default for the whole horizon. There is no drawdown modeling, so an unlucky sequence of returns can leave the real outcome well below the projection.
- **Illustrative dataset.** Prices, card terms and duty tables are demo data, not live quotes.

## License

SpendWise is released under the MIT license.
