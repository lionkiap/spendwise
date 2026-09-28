# SpendWise: hackathon submission

**Track:** NVIDIA Nemotron on Nebius Token Factory, Best Apps and Agents

## What we created

SpendWise is a Singapore-focused financial goal planner with a built-in credit card maximizer, shipped as a Next.js 14 app (TypeScript strict mode, React 18, plain CSS, vitest).

You describe a goal in one sentence, for example "I want to buy a HDB worth about 600k by age 28". NVIDIA Nemotron Super, served by Nebius Token Factory through its OpenAI-compatible endpoint, compiles that sentence into a validated GoalSpec. From there SpendWise computes a complete plan with pure deterministic functions: the required monthly saving, the upfront cost stack (buyer stamp duty, ABSD, the 5 percent minimum cash leg, legal fees, renovation buffer), a savings schedule, concessionary and stress-tested mortgage installments with MSR and TDSR checks, a CPF OA projection, a nine-cell what-if grid, a milestone timeline and teaching points. Assumption chips name every number the prompt left unstated.

The second tab is a credit card maximizer that runs entirely in the browser. It ranks 14 illustrative Singapore cards for each expense against bonus tiers, monthly caps, minimum spends and a miles valuation you control, shows the arithmetic behind every ranking in a math trace and audits your logged month against an always-optimal chooser to report exactly how much reward was left on the table and why.

## Submission artifacts

- **Deployed demo:** not hosted yet. Add the live URL here before submitting. Until then the demo is run-it-yourself with the three commands in the README.
- **Video walkthrough:** not recorded yet. Add the link here. The three-beat script in the README is the shooting script.
- **Screenshots:** not added yet. Three images would cover it: the plan view with the cost stack and MSR and TDSR pills, a card ranking with its math trace and the left-on-the-table audit.
- **Team and contact:** not stated in the repo yet. Add names, team or course and an email here.

## Why we created it

Two problems, one design decision.

First, people abandon financial planning because the first question is already hard: "what would buying a flat at 28 actually require of me every month?" A prompt lowers that barrier to a sentence. So we made the prompt the input and compiled it, like a compiler, into a structured spec and then a plan.

Second, credit card rewards in Singapore are genuinely combinatorial: bonus tiers, monthly caps, minimum spends and miles valuations interact, so most people leave real money on the table every month. That is a deterministic optimization problem, not a chat problem.

The design decision: an LLM that does arithmetic is a liability. In a financial tool every figure must be reproducible and testable. So the LLM's job is bounded to one thing: turning language into a typed spec. Every number in the product comes from pure, unit-tested kernels. This also made the credits story trivial: a single model call per plan on the happy path and zero model calls everywhere else, which is exactly what a Token Factory track rewards.

## How it works

1. **Parse (the only model call).** `POST /api/plan` receives `{ prompt, profile }`. If `NEBIUS_API_KEY` is set, Nemotron Super gets a system prompt describing the three GoalSpec shapes and must answer with one JSON object, at temperature 0 with `response_format: json_object` (`src/lib/planner/parse.ts:25`). The reply is stripped of fences and reasoning prefixes, validated against a zod discriminated union and retried once with the validation issues fed back. Any failure falls back to a deterministic regex parser, so the app works offline and the demo cannot die. The route attributes the parser conservatively by re-running the offline parser as a witness; the UI badges which one ran (`src/app/api/plan/route.ts:69`).
2. **Fill gaps.** `missingFields` reports what the prompt left out. `fillAssumptions` fills each gap from named snapshot defaults (4 percent mortgage stress rate, 2.6 percent HDB concessionary rate, 2.5 percent inflation, S$30,000 renovation buffer, 1.8 percent instrument rate) and every fill becomes a visible chip with a reason (`src/lib/planner/parse.ts:303`).
3. **Compute.** `buildPlan` orchestrates the pure kernels in `src/lib/kernels`: time value of money (`fvLump`, `fvAnnuity`, `pmtForFv`, `rateForFv` by bisection, `amortize`, `realValue`), Singapore property (`bsd` marginal tiers, `absd`, `downPaymentSplit` at the 75 percent LTV frame, `msrCheck` 30 percent, `tdsrCheck` 55 percent), CPF (`oaProjection` at the 2.5 percent OA floor, `opportunityCostOfCpf`) and car financing (`carLoanLimits`, `flatToEffective`, `tcoCompare`). Output is a PlanJSON the UI renders read-only (`src/lib/planner/build.ts:690`). No Date, no Math.random, no locale-dependent formatting.
4. **Route and audit, client-side, zero calls.** `routeExpense` scores the wallet for one purchase honoring caps already consumed this month, minimum-spend gating and the miles valuation slider (1.4 to 2.4 cents), best first with a full math trace (`src/lib/cards/engine.ts:222`). `walletAudit` replays the logged month twice, once over the cards actually used and once over an always-optimal chooser whose cap state evolves with its own choices, then reports `leftOnTableSgd` plus a why per miss (`src/lib/cards/engine.ts:264`).

The vitest suite covers the kernels, the card engine and the planner (including the offline path returning exactly what the heuristic parser produces).

## Track category

**Best Apps and Agents**, under the NVIDIA Nemotron on Nebius Token Factory track. SpendWise is an app with an agent-shaped core: a model call that turns intent into a typed spec inside a larger deterministic system, not a chat wrapper.

## How it meets the track requirements

Note on sourcing: the mapping below addresses the track elements this submission was built against (NVIDIA Nemotron models, the Nebius Token Factory platform, a working app with a live demo). We did not have the official rubric wording when writing this section, so check each claim against the current track page.

- **Built on NVIDIA Nemotron.** The model roles are Nemotron across the board: `nvidia/llama-3.1-nemotron-ultra-253b-v1` (Ultra, reserved for plan orchestration and narrative), `nvidia/llama-3.3-nemotron-super-49b-v1.5` (Super, the live GoalSpec parser), `nvidia/nemotron-nano-9b-v2` (Nano, reserved for fast chat). All three ids are env-configurable (`src/lib/nebius.ts:29`, `.env.example`) and are illustrative defaults: both files say to check them against the Nebius Token Factory model catalog (https://docs.tokenfactory.nebius.com/) before relying on them.
- **Uses Nebius Token Factory as the inference platform.** All inference goes through the Token Factory OpenAI-compatible endpoint (`https://api.tokenfactory.nebius.com/v1`) with the official `openai` SDK, strict JSON mode at temperature 0, fail-soft error handling and a corrective retry loop.
- **A working demo.** The committed demo is run-it-yourself: `npm install && cp .env.example .env.local && npm run dev` starts both tabs, with or without an API key (the local fallback parser covers the offline path). A hosted demo URL, a recorded walkthrough and screenshots are not committed yet; the placeholders in the Submission artifacts section above must be filled before submitting. The three-beat script in the README covers planning a 600k HDB goal, routing a dining expense and proving the offline path on camera.
- **An app, not a wrapper.** The model is one stage of a pipeline with a typed contract (zod) at its boundary and 100 percent of the numeric output produced by pure functions under vitest. The what-if grid, card routing and the wallet audit need no model call at all.
- **Honesty as a feature.** Parser attribution is proven, not assumed: the route re-runs the offline parser as a witness and only badges "Nemotron" when the output differs from what the offline parser produces. Every card carries a `sourceNote` disclaimer and the footer states the whole thing is an educational demo, not financial advice.

## Which Nebius services are used

- **Nebius Token Factory** (model inference): the per-plan chat completion that parses the prompt into a GoalSpec, via the OpenAI-compatible API at `https://api.tokenfactory.nebius.com/v1` with Nemotron Super on the live path and Nemotron Ultra and Nano as env-configurable roles. One call on the happy path, at most four completions when retries stack (see the README's credits section).
- **Nebius Serverless Endpoints** (optional deployment path): `NEBIUS_BASE_URL` accepts any OpenAI-compatible endpoint URL, so the same build can point at a dedicated serverless endpoint with no code change.

Nothing else from Nebius is required: state lives in the browser, the plan is computed in-process and the card engine never leaves the client.

## Stack

Next.js 14 (App Router) with TypeScript strict mode, React 18, zod for the GoalSpec and request contracts, the `openai` SDK pointed at Nebius Token Factory, vitest for the kernel, engine and planner tests and plain hand-written CSS in `src/app/globals.css` (no Tailwind, no UI or chart libraries). MIT licensed.
