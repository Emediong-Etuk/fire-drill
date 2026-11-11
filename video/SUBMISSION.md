# Submission text

Ready to paste into the hackathon form. Pick the length each field allows. Every number
here comes from runs made while building the project (Otari `1726b58`, local Docker,
real models through OpenRouter).

## Links

- Repository: https://github.com/Emediong-Etuk/fire-drill
- Pitch video: https://youtu.be/63MKmGHBbZQ
- Technical walkthrough: https://youtu.be/ZBIyt2jhovY
- npm: `otari-firedrill` (only once you have run `npm publish`; otherwise leave it out)

## Name

Fire Drill

## Tagline (under 100 characters)

Rehearse your Otari fallback routes before an outage does it for you.

## One-paragraph summary (about 60 words)

Otari routing policies put several models behind one name, but the backup legs only run
when the primary fails or a budget cap fires: in production, on the worst day. Fire Drill
replays your real requests down every leg ahead of time, checks each answer against what
the request demands, and tells you which leg would break your app and what to change.

## Full description (about 300 words)

**The problem.** A routing policy in Otari gives your app one model name with a primary
model and cheaper or backup models behind it. Your tests only ever reach the primary. The
first time your app meets the backup is during an outage or when a budget tier-down
fires, which is exactly when a cheaper model breaks your JSON schema or your tool calls.
This problem exists because the gateway puts several models behind one name.

**What Fire Drill does.** One command, `firedrill <policy>`, reads the policy from Otari
and turns it into ordered legs. It mints a throwaway API key with its own budget and a
model allow-list of just those legs, then replays your recorded requests down every leg.
It works out the contract from each request itself, so there are no tests to write: a
`json_schema` response format must validate, offered tools must be called with valid
arguments, and text must not be empty, cut off or refused. The report shows each leg's
pass rate, latency, cost per request and per 1,000 requests, every failure with a
redacted excerpt, and one line saying what to change. The exit code fails a CI job when
a leg breaks.

**In the demo**, three real models sit behind `demo-chat`. Gemma 3 12B passes every
JSON-schema sample but calls `get_weather` without its required arguments, which it did
on every one of 30+ tries. Fire Drill reports "Leg 2 fails 1/5 tool-call checks. Move it
below leg 3 or remove it," and the drill key is gone from Otari before the report prints.

**Built to be safe to run against a real gateway.** Keys are never printed. The drill key
is revoked on success, failure, Ctrl-C and crash. The budget is enforced twice, by Otari
and client-side. Replays never carry web tools, and model-written code only ever runs in
Otari's sandbox.

## How it uses Otari

- **Routing policies:** reads `GET /api/v1/routing/policies` and drills every candidate:
  primary, failovers, budget tier-downs and router pools.
- **Virtual keys:** a per-run key with a model allow-list and a short expiry, deleted
  after the drill.
- **Budgets:** a per-run budget on a per-run user; Otari refuses past it with
  `403 budget_exceeded`.
- **Usage tracking:** cost from `usage.cost_usd` on every response, cross-checked against
  `GET /api/v1/key/budget`; every replay is tagged so the drill can be found on Otari's
  Requests tab.
- **Served-model headers:** `Otari-Provider` and `Otari-Model` prove which model answered.
- **Code execution:** `--run-code` runs each answer's Python in Otari's sandbox through
  `POST /api/v1/code/execute`, priced from Otari's own rate.
- **Workspace policies:** warns when web tools are on, and `--lock-down` switches them off
  for the drill and restores them afterwards.

## What was built and verified

- A TypeScript CLI with no server and no database; it talks only to the Otari gateway.
- 96 automated tests, including whole drills against a fake Otari, revocation on SIGINT
  and SIGTERM, both budget stops, and a test that greps all output for leaked keys. CI
  runs them on Node 20, 22 and 24.
- Verified live against Otari in Docker: the demo drill, `--trace`, `--run-code`,
  `--lock-down`, `--record`, Otari's own budget refusal, and that Fire Drill's spend
  total matched the gateway's to the micro-dollar on every run.

## Tech stack

TypeScript on Node 20+, commander, zod, ajv, Vitest, tsup. Demo: Otari, Postgres and
Otari's code sandbox in Docker Compose, with models through OpenRouter.

## Challenges

- Otari has no header that forces a policy onto one candidate, so each leg is called
  directly. That reproduces schema and tool behaviour faithfully, but a policy's mandatory
  guardrails don't run during a drill. The README says so.
- Making the client-side budget agree with the gateway: sandbox runs report no cost in
  their response, so Fire Drill reads Otari's per-run price before running code.

## What's next

Replaying Messages and Responses requests and streamed responses, comparing each leg's
answer with the primary's by meaning rather than shape, and reading policies through
Otari's organization routes for teams without the master key.
