# SpendWise

Tell SpendWise your money goal in plain English and it compiles the prompt into a full deterministic plan, then routes every card purchase in your wallet to the best reward.

## What it is and why

SpendWise is two tools in one Next.js app, built for the NVIDIA Nemotron on Nebius Token Factory track (Best Apps and Agents):

1. **A prompt-driven financial goal compiler.** You type "I want to buy a HDB worth about 600k by age 28". Nemotron Super parses that sentence into a validated GoalSpec. Snapshot assumptions fill whatever the prompt left unstated and pure TypeScript kernels compute the whole plan: the upfront cost stack with buyer stamp duty, the required monthly saving, the savings schedule, MSR and TDSR debt checks, a nine-cell what-if grid, milestones and teaching points. The LLM parses language; it never computes a number.
2. **A credit card maximizer.** In the browser, with zero model calls, a deterministic engine ranks your wallet for each expense against bonus tiers, monthly caps, minimum spends and a miles valuation you control. A wallet audit then replays your logged month against an always-optimal chooser and shows exactly how much reward was left on the table, purchase by purchase.

We built it this way because a financial tool that lets a language model do arithmetic is a tool that can be confidently wrong. Here every figure traces to a pure, tested function and every model output passes a zod gate before anything downstream sees it.

## Features

**Goal Planner**

- Plain English goals in three shapes: savings target, property purchase (HDB resale, BTO or condo) and car purchase (`src/lib/planner/goalspec.ts`)
- Nemotron parsing with one corrective retry, always validated by a zod discriminated union before use (`src/lib/planner/parse.ts:56`)
- A local regex fallback parser so the planner works with no API key and no network (`src/lib/planner/parse.ts:217`)
- Assumption chips that name every number the prompt left out and why it was filled, including five snapshot defaults such as the 4 percent stress rate and 2.5 percent inflation
- Upfront cost stack: BSD by marginal tiers, ABSD by citizenship and property count, the 5 percent minimum cash leg of the down payment, legal fee estimates and a renovation buffer for resale flats (`src/lib/kernels/property.ts`)
- Mortgage check at the 2.6 percent concessionary rate plus a 4 percent stress test, with MSR (30 percent) and TDSR (55 percent) pass and fail pills
- CPF OA projection at the 2.5 percent floor rate and the opportunity cost of drawing CPF down (`src/lib/kernels/cpf.ts`)
- A nine-cell scenario grid: rate down 1 point, as-is and up 1 point, crossed with saving 20 percent less, as planned and 20 percent more
- Milestone timeline and teaching points: compounding, inflation-adjusted real value, CPF opportunity cost, rate sensitivity

**Card Maximizer**

- 14 illustrative Singapore cards (8 cashback, 6 miles) in `src/lib/data/cards.ts`, each carrying a `sourceNote` disclaimer
- Best-card ranking per expense that honors category bonus tiers, monthly caps reduced by spend already logged, minimum-spend gating and miles valuation (`src/lib/cards/engine.ts:222`)
- A human-readable `mathTrace` for every recommendation showing the rate, cap headroom, overflow and reward arithmetic
- A miles valuation slider (1.4 to 2.4 SGD cents per mile) that can flip a ranking live
- Minimum spend progress and top category cap usage bars for the current month
- A wallet audit that replays the month twice (actual versus always-optimal) and reports what was left on the table with a "why" per miss (`src/lib/cards/engine.ts:264`)
- Profile, wallet and ledger persist in localStorage (`sw_profile`, `sw_wallet`, `sw_ledger`)

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
                       PlanJSON -> verdict, three actions, required
                       monthly saving, cost stack, schedule, debt
                       check, scenario grid, milestones, teaching

 Card Maximizer tab (client side only, zero model calls)
 -------------------------------------------------------
   wallet + ledger (localStorage, month-tagged entries)
        |                    |
        v                    v
   routeExpense         walletAudit
   ranks the wallet     replays the month: actual cards vs an
   for one expense      always-optimal chooser; reports
   with caps, minimum   leftOnTableSgd and a why per miss
   spends and miles
   valuation
```

Every arrow into the plan passes through a pure function. The only network hop in the whole app is the prompt parse.

## How we use NVIDIA Nemotron

SpendWise talks to Nebius Token Factory through the official `openai` SDK pointed at the OpenAI-compatible endpoint (`https://api.tokenfactory.nebius.com/v1`, override with `NEBIUS_BASE_URL`). The wrapper in `src/lib/nebius.ts` asks for strict JSON with `response_format: json_object` at temperature 0, strips markdown fences and reasoning prefixes from the reply and fails soft to null so the app can fall back offline.

Three model roles, each an environment-configurable id (see `.env.example`). The default ids are illustrative: both `.env.example` and `src/lib/nebius.ts` say so and point to the Nebius Token Factory model catalog (https://docs.tokenfactory.nebius.com/). Check them there before relying on them; any role can be swapped by env with no code change:

| Role  | Default id in .env.example                        | Job in SpendWise |
|-------|---------------------------------------------------|------------------|
| Ultra | `nvidia/llama-3.1-nemotron-ultra-253b-v1`         | Plan orchestration, scenario narrative and audit explanations. Reserved as the reasoning-heavy slot for the hardest calls. |
| Super | `nvidia/llama-3.3-nemotron-super-49b-v1.5`        | The live job today: GoalSpec and expense parsing. `superModel()` is the model on the wire in `src/lib/planner/parse.ts:62`. |
| Nano  | `nvidia/nemotron-nano-9b-v2`                      | Reserved for fast chat on the happy path, where a small model keeps latency and tokens low. |

Override any role without touching code:

```
NEMOTRON_ULTRA_MODEL=...
NEMOTRON_SUPER_MODEL=...
NEMOTRON_NANO_MODEL=...
```

Honest note: in this MVP the Super role is wired into the running pipeline (prompt to GoalSpec), while the Ultra and Nano roles exist as env-configurable slots awaiting their call sites; the plan narrative and audit explanations are currently written by the deterministic builders in `src/lib/planner/build.ts`, which is also why they are reproducible.

## Credits strategy: minimal tokens by design

Deterministic kernels keep token usage minimal:

- **One model call per plan, four completions at worst.** The happy path is a single chat completion. Two retries can stack on top of that: the corrective retry in `src/lib/planner/parse.ts:68` when a reply fails zod validation and the wrapper's own retry without `response_format` in `src/lib/nebius.ts:119` when the endpoint rejects that option. Each of the two calls can therefore run twice. Everything after the GoalSpec is arithmetic.
- **Zero calls for what-if changes.** The nine-cell scenario grid is recomputed locally from `pmtForFv` on every plan. Dragging the miles valuation slider reranks the wallet instantly with no round trip.
- **Zero calls for card routing and the audit.** The entire Card Maximizer tab, including the wallet audit replay, runs in the browser. You can demo it on a plane.

## Setup

Requirements: Node 18 or later (Next.js 14 needs 18.17 or newer) and npm.

```
npm install
cp .env.example .env.local
# add your NEBIUS_API_KEY from the Nebius Token Factory console
npm run dev
```

Then open http://localhost:3000.

Filename note: the header inside `.env.example` says "Copy to .env" while the command above uses `.env.local`. Next.js loads either and this repo's `.gitignore` excludes both (pattern `.env*`), so pick one and stay with it.

**No key? It still works.** Without `NEBIUS_API_KEY` the app detects that Nebius is unconfigured and the local regex parser takes over, so both tabs remain fully functional for demos. The UI labels which parser produced each plan ("Parsed by Nemotron on Nebius" versus "Parsed by the local fallback parser"). The route attributes the parser conservatively by re-running the offline parser as a witness (`src/app/api/plan/route.ts:69`).

Run the tests:

```
npm test
```

## Deploying with Nebius Serverless Endpoints (optional)

The app is a standard Next.js deployment plus one secret. To serve the models from Nebius Serverless Endpoints instead of the shared Token Factory API:

1. Deploy or select your Nemotron model on a Nebius serverless endpoint and copy its base URL.
2. Set `NEBIUS_BASE_URL` in your hosting provider's environment to that endpoint's OpenAI-compatible URL and keep `NEBIUS_API_KEY` set there too. No code change is needed because the client is built from env at call time.
3. Deploy the Next.js app anywhere Node 18 runs (`npm run build` then `npm start`) or to a platform that runs the build for you. Only `/api/plan` touches the model. Splitting the frontend from a separately hosted API would need a small code change first: the client calls the hard-coded relative path `fetch('/api/plan')` in `src/app/page.tsx:624` and no public API base URL is configurable in `src/` today.

## Demo video script (three beats)

Record these beats and link the video, plus a hosted demo URL, from PROJECT_DESCRIPTION.md before submitting. Neither artifact is committed yet.

1. **The plan (about 60 seconds).** Type "I want to buy a HDB worth about 600k by age 28" with the default profile. Walk the result top to bottom: the verdict hero, the three actions, the cost stack and its BSD row (S$12,600, computed by the kernel from the statutory IRAS tiers), the MSR and TDSR pills, the savings schedule and the scenario grid. Point at the assumption chips and the parser badge showing Nemotron did the parsing.
2. **The wallet (about 60 seconds).** Switch to Card Maximizer. Pick a wallet, enter a S$120 dining expense and show the ranked list with a math trace. Slide the miles valuation to flip the winner. Log the pick, log a deliberately bad one, then show the audit: what the month earned versus the optimal chooser and the exact dollars left on the table with the why.
3. **The architecture (about 30 seconds).** Show `.env.local` with no API key, replan and land on the local fallback parser with the same plan. Close on the point: a single model call per plan on the happy path, zero calls for what-ifs and card routing, every number from a tested pure function.

## Disclaimers

- **Card terms are illustrative.** All 14 cards in `src/lib/data/cards.ts` are published-style simplifications as of 2025. Rates, caps, minimum spends and exclusions change constantly and each card carries a `sourceNote` saying so. Verify every term with the issuer before relying on it.
- **Duty tables and lending rules are snapshots.** The BSD tiers in `src/lib/kernels/property.ts` implement the statutory residential schedule in force since 15 Feb 2023, verified against IRAS: 1 percent of the first 180k, 2 percent of the next 180k, 3 percent of the next 640k, 4 percent up to 1.5m, 5 percent up to 2m and 6 percent from 3m, which produces S$12,600 on a 600k purchase. The car financing caps in `src/lib/kernels/car.ts` follow the MAS rules for motor vehicle loans: 70 percent LTV with a 7 year tenor at OMV up to 20k, 60 percent LTV with a 5 year tenor above that. ABSD rates, the property LTV frame, MSR and TDSR limits and CPF rates remain hackathon snapshots. Re-verify everything against IRAS, MAS, CPF and LTA before production or advisory use.
- **This is not financial advice.** SpendWise is an educational hackathon demo. Nothing it outputs is a recommendation to buy any property, car, card or instrument.

## Known limitations

- **Single user.** No accounts, no server-side storage. Your profile, wallet and ledger live in one browser's localStorage and are gone if you clear it.
- **localStorage persistence only.** Nothing syncs across devices and there is no backup or export.
- **Heuristic fallback parser.** The offline parser is regex-based. It handles the documented prompt shapes (age deadlines, "in N years", k/m/mil/million amounts, percent rates) but not free-form phrasing. It silently returns a sentinel-zero amount when it cannot find a number, which the plan then surfaces as a missing field. The Nemotron path handles broader phrasing but needs a key.
- **Illustrative dataset.** Prices, card terms and duty tables are demo data, not live quotes.

## License

SpendWise is released under the MIT license.
