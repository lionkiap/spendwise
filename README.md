# SpendWise

Tell SpendWise your money goal in plain English and it compiles the prompt into a full deterministic plan, then routes every card purchase in your wallet, including cards you add yourself, to the best reward.

## What it is and why

SpendWise is two tools in one Next.js app, built for the NVIDIA Nemotron on Nebius Token Factory track (Best Apps and Agents):

1. **A prompt-driven financial goal compiler.** You type "I want to buy a HDB worth about 600k by age 28". Nemotron Super parses that sentence into a validated GoalSpec. Snapshot assumptions fill whatever the prompt left unstated and pure TypeScript kernels compute the whole plan: the upfront cost stack with buyer stamp duty, the required monthly saving, the savings schedule, MSR and TDSR debt checks, a nine-cell what-if grid, milestones and teaching points. An optional investment portfolio is credited toward the goal first and grows at its own rate, and car goals add a total cost of ownership block. Nemotron Ultra may then rewrite the verdict reasoning and teaching bodies, and a badge says which engine wrote the words. The LLM parses language and rewords narrative; it never computes a number.
2. **A credit card maximizer.** In the browser, with zero model calls for every routing and audit figure, a deterministic engine ranks your wallet for each expense against bonus tiers, monthly caps, minimum spends and a miles valuation you control. Add your own cards from your statement and the engine scores them exactly like the built-ins. A wallet audit then replays your logged month against an always-optimal chooser and shows exactly how much reward was left on the table, purchase by purchase, with an optional Nemotron Ultra rephrasing of each miss behind a button.

We built it this way because a financial tool that lets a language model do arithmetic is a tool that can be confidently wrong. Here every figure traces to a pure, tested function and every model output passes a zod gate before anything downstream sees it.

## Features

**Goal Planner**

- Plain English goals in three shapes: savings target, property purchase (HDB resale, BTO or condo) and car purchase (`src/lib/planner/goalspec.ts`)
- Nemotron parsing with one corrective retry, always validated by a zod discriminated union before use (`src/lib/planner/parse.ts:56`)
- A local regex fallback parser so the planner works with no API key and no network (`src/lib/planner/parse.ts:217`)
- Investments as a planner input: the optional Investments and Expected return fields in the Your profile card on the Goal Planner tab (`src/app/components/planner-tab.tsx:97`) credit an existing portfolio toward the goal first, compounding at its own rate, so the required monthly saving drops by the projected future value (`src/lib/planner/goalspec.ts:85`)
- Assumption chips that name every number the prompt left out and why it was filled, including six snapshot defaults such as the 4 percent stress rate, 2.5 percent inflation and the 4.5 percent investment growth rate that appears only when a portfolio exists and its rate is unstated
- Upfront cost stack: BSD by marginal tiers, ABSD by citizenship and property count, the 5 percent minimum cash leg of the down payment, legal fee estimates and a renovation buffer for resale flats (`src/lib/kernels/property.ts`)
- Mortgage check at the 2.6 percent concessionary rate plus a 4 percent stress test, with MSR (30 percent) and TDSR (55 percent) pass and fail pills
- CPF OA projection at the 2.5 percent floor rate and the opportunity cost of drawing CPF down (`src/lib/kernels/cpf.ts`)
- Total cost of ownership for car goals: per-year financing, insurance, road tax, energy and maintenance plus the horizon total, every figure from the `tcoCompare` kernel with each input exposed as a readable assumption line (`src/lib/planner/build.ts:685`)
- A nine-cell scenario grid: rate down 1 point, as-is and up 1 point, crossed with saving 20 percent less, as planned and 20 percent more
- Milestone timeline and teaching points: compounding, inflation-adjusted real value, CPF opportunity cost, rate sensitivity
- A Nemotron Ultra narrative pass that rewrites only the verdict reasoning and teaching bodies of the already computed plan, copying every figure verbatim, with a visible engine badge and a deterministic fallback (`src/lib/planner/narrative.ts:89`)

**Card Maximizer**

- 14 illustrative Singapore cards (8 cashback, 6 miles) in `src/lib/data/cards.ts`, each carrying a `sourceNote` disclaimer, plus any cards you add yourself
- Custom cards: a zod-validated form parses name, issuer, reward type, base rate, up to eight bonus tiers, optional minimum spend and annual fee, sanity checks the rates (cashback between 0 and 20 percent, miles between 0.5 and 10 per dollar), slugs the id and forces the fixed user-entry disclaimer, then merges the saved deck after the built-ins with collision-safe ids (`src/lib/cards/custom.ts:179`, `src/lib/cards/custom.ts:233`)
- Best-card ranking per expense that honors category bonus tiers, monthly caps reduced by spend already logged, minimum-spend gating and miles valuation (`src/lib/cards/engine.ts:222`)
- A human-readable `mathTrace` for every recommendation showing the rate, cap headroom, overflow and reward arithmetic
- A miles valuation slider (1.4 to 2.4 SGD cents per mile) that can flip a ranking live
- Minimum spend progress and top category cap usage bars for the current month
- A wallet audit that replays the month twice (actual versus always-optimal) and reports what was left on the table with a "why" per miss (`src/lib/cards/engine.ts:264`)
- A ledger manager with per-row delete, clear month and a one-click realistic sample month so the audit can be demoed cold (`src/app/components/ledger-manager.tsx:55`)
- An optional Explain misses button that posts the deterministic misses to `/api/audit/explain` for a Nemotron Ultra rephrasing, one call per press, with the deterministic why text standing in whenever the key is missing or the reply is unusable (`src/app/components/cards-tab.tsx:189`)
- Profile, wallet, ledger and custom cards persist in localStorage (`sw_profile`, `sw_wallet`, `sw_ledger`, `sw_custom_cards`)

## Architecture

```
        prompt: "buy a HDB worth 600k by age 28"          profile form
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

 GET /api/status -> { nebiusConfigured, models } -> header pill
 (Local mode vs Nemotron connected; reads env only, the key never
  leaves the server)
```

Every arrow into the plan passes through a pure function. The model is touched in exactly three places: the Super call that parses the prompt, the Ultra call that rewords the plan narrative and the optional Ultra call behind the audit explain button. Everything else, including all card routing and all audit arithmetic, runs locally.

## How we use NVIDIA Nemotron

SpendWise talks to Nebius Token Factory through the official `openai` SDK pointed at the OpenAI-compatible endpoint (`https://api.tokenfactory.nebius.com/v1`, override with `NEBIUS_BASE_URL`). The wrapper in `src/lib/nebius.ts` asks for strict JSON with `response_format: json_object` at temperature 0, strips markdown fences and reasoning prefixes from the reply and fails soft to null so the app can fall back offline.

Three model roles, each an environment-configurable id (see `.env.example`). The default ids are illustrative: both `.env.example` and `src/lib/nebius.ts` say so and point to the Nebius Token Factory model catalog (https://docs.tokenfactory.nebius.com/). Check them there before relying on them; any role can be swapped by env with no code change:

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
- **Zero calls for card routing and the audit math.** The entire Card Maximizer tab, including custom card validation, the merged deck, the routing engine and the wallet audit replay, runs in the browser. The audit's dollars-left-on-the-table figure is computed before any model is consulted. The one optional exception is the Explain misses button: one Ultra call per press, never automatic (`src/app/components/cards-tab.tsx:189`). You can still demo the whole tab on a plane; the button just answers deterministic without a key.

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

**No key? It still works.** Without `NEBIUS_API_KEY` the app detects that Nebius is unconfigured and every model-touching path degrades: the local regex parser takes over the prompt, the narrative pass returns the deterministic plan with `narrativeEngine: 'deterministic'` and the explain endpoint answers deterministic so the client keeps the engine's own why text. Both tabs remain fully functional for demos. The header pill reads `/api/status` and shows Local mode versus Nemotron connected (`src/app/components/header.tsx:49`), the plan carries the parser badge ("Parsed by Nemotron on Nebius" versus "Parsed by the local fallback parser") and the teaching section carries the engine badge ("Explanations by Nemotron Ultra" versus "Deterministic explanations", `src/app/components/plan-view.tsx:295`). The route attributes the parser conservatively by re-running the offline parser as a witness (`src/app/api/plan/route.ts:72`).

Run the tests:

```
npm test
```

## Deploying with Nebius Serverless Endpoints (optional)

The app is a standard Next.js deployment plus one secret. To serve the models from Nebius Serverless Endpoints instead of the shared Token Factory API:

1. Deploy or select your Nemotron model on a Nebius serverless endpoint and copy its base URL.
2. Set `NEBIUS_BASE_URL` in your hosting provider's environment to that endpoint's OpenAI-compatible URL and keep `NEBIUS_API_KEY` set there too. No code change is needed because the client is built from env at call time.
3. Deploy the Next.js app anywhere Node 18 runs (`npm run build` then `npm start`) or to a platform that runs the build for you. Only `/api/plan` and `/api/audit/explain` touch the model; `/api/status` reads environment configuration only. Splitting the frontend from a separately hosted API would need a small code change first: the client calls the hard-coded relative paths `fetch('/api/plan')` in `src/app/page.tsx:224` and `fetch('/api/audit/explain')` in `src/app/components/cards-tab.tsx:199`, and no public API base URL is configurable in `src/` today.

## Demo video script (three beats)

Record these beats and link the video, plus a hosted demo URL, from PROJECT_DESCRIPTION.md before submitting; its Submission artifacts section is an open checklist covering the video, the URL, screenshots and team contact, and neither the video nor the URL is committed yet. The Deploying section below is the path to producing the hosted URL.

1. **The plan (about 60 seconds).** Point at the header status pill first so viewers know whether Nemotron is connected. Type "I want to buy a HDB worth about 600k by age 28" with the default profile, then enter 20000 in the "Investments (S$, optional)" field of the Your profile card at the top of the Goal Planner tab (`src/app/components/planner-tab.tsx:97`) and press Plan again to show the required monthly saving drop and the 4.5 percent investment growth chip appear. Walk the result top to bottom: the verdict hero, the three actions, the cost stack and its BSD row (S$12,600, from the first three marginal tiers, which match the IRAS schedule), the MSR and TDSR pills, the savings schedule and the scenario grid. Close on the parser badge and the engine badge on the teaching section saying who parsed and who wrote the words.
2. **The wallet (about 75 seconds).** Switch to Card Maximizer. Pick a wallet, enter a S$120 dining expense and show the ranked list with a math trace. Slide the miles valuation to flip the winner. Click "Add your own card", enter a card with a dining tier that beats the whole deck and route the same S$120 again: the custom card wins, carries the Custom badge and shows its "User-entered terms. Not verified against any issuer." sourceNote. Click "Load sample month", show the audit: what the month earned versus the optimal chooser and the exact dollars left on the table with the why. Then press "Explain misses with Nemotron" and show the Ultra rephrasing appear under each miss (or the Local mode note when no key is set).
3. **The architecture (about 30 seconds).** Show `.env.local` with no API key, replan and land on the local fallback parser with the same plan, the teaching badge reading "Deterministic explanations" and the header pill reading Local mode. Close on the point: one Super call to parse plus one Ultra call to narrate per plan on the happy path, zero calls for what-ifs, card routing and the audit math, every number from a tested pure function.

## Disclaimers

- **Card terms are illustrative.** All 14 cards in `src/lib/data/cards.ts` are published-style simplifications as of 2025. Rates, caps, minimum spends and exclusions change constantly and each card carries a `sourceNote` saying so. Verify every term with the issuer before relying on it.
- **Custom cards are user-entered and unverified.** Every card you add yourself is forced to carry the fixed sourceNote "User-entered terms. Not verified against any issuer." (`src/lib/cards/custom.ts:16`). The form sanity checks ranges (cashback between 0 and 20 percent, miles between 0.5 and 10 per dollar, at most eight tiers) but nothing cross-checks your terms against a real issuer, so a mistyped cap or rate routes confidently wrong until you fix it.
- **Investment growth is an assumption.** When you state a portfolio but no rate, the planner assumes 4.5 percent a year and shows a chip saying so (`src/lib/planner/goalspec.ts:27`). The projection is a smooth compounding curve with no volatility, sequence risk, fees or taxes; it is a planning aid, not a forecast.
- **Duty tables and lending rules are snapshots.** The statutory residential BSD schedule in force since 15 Feb 2023 runs 1 percent of the first 180k, 2 percent of the next 180k, 3 percent of the next 640k, 4 percent of the next 500k up to 1.5m, 5 percent of the next 1.5m up to 3m and 6 percent only above 3m. The tier table in `src/lib/kernels/property.ts` matches that statute exactly up to 2m and produces S$12,600 on a 600k purchase, but it starts the 6 percent band at 2m instead of 3m (`src/lib/kernels/property.ts:24`), so a price above 2m is overcharged by 1 percent of the portion between 2m and 3m, at most S$10,000. The car financing caps in `src/lib/kernels/car.ts` follow the MAS rules for motor vehicle loans: 70 percent LTV with a 7 year tenor at OMV up to 20k, 60 percent LTV with a 5 year tenor above that. ABSD rates, the property LTV frame, MSR and TDSR limits and CPF rates remain hackathon snapshots. Re-verify everything against IRAS, MAS, CPF and LTA before production or advisory use.
- **This is not financial advice.** SpendWise is an educational hackathon demo. Nothing it outputs is a recommendation to buy any property, car, card or instrument.

## Known limitations

- **Single user.** No accounts, no server-side storage. Your profile, wallet, ledger and custom cards live in one browser's localStorage and are gone if you clear it.
- **localStorage persistence only.** Nothing syncs across devices and there is no backup or export.
- **Heuristic fallback parser.** The offline parser is regex-based. It handles the documented prompt shapes (age deadlines, "in N years", k/m/mil/million amounts, percent rates) but not free-form phrasing. It silently returns a sentinel-zero amount when it cannot find a number, which the plan then surfaces as a missing field. The Nemotron path handles broader phrasing but needs a key.
- **User-entered card terms are unverified.** A custom card is scored by the same engine as the built-ins, which is the point and also the risk: nothing validates your entered cap, rate or minimum spend against the issuer. The forced disclaimer and range checks are the only guards.
- **Investments grow at an assumed rate.** The portfolio leg compounds at your stated rate or the 4.5 percent default for the whole horizon. There is no drawdown modeling, so an unlucky sequence of returns can leave the real outcome well below the projection.
- **Illustrative dataset.** Prices, card terms and duty tables are demo data, not live quotes.

## License

SpendWise is released under the MIT license.
