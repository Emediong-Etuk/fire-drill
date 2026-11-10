# Fire Drill: research notes (Step 0)

Source read: `mozilla-ai/otari` cloned into `vendor-ref/otari/` (gitignored), commit
`1726b58` (10 Nov 2026). All references below are paths inside that clone, with line
numbers at that commit. "Docs" means `docs/`, "spec" means the committed OpenAPI file
`docs/public/openapi.json`, and "src" means `src/gateway/`.

## Credentials: the two-key model

| Credential | What it is | Fire Drill flag |
| --- | --- | --- |
| **Master key** (`OTARI_MASTER_KEY`) | Deployment-wide admin credential. Required by every management router through `require_deployment_operator` (`src/gateway/api/deps.py:794`). | `--admin-key` / `$OTARI_ADMIN_KEY` |
| **API key** (`tk-...` self-hosted, `otk_...` on otari.ai) | Workload credential bound to one user and one workspace (`docs/api-keys.md:1-4`). Reaches inference, `/api/v1/tools`, `/api/v1/key/*`, `GET /api/v1/usage/requests/{id}` for its own requests (`docs/api-reference.md:60-76`). | `--key` / `$OTARI_API_KEY` |

Both are accepted as `Authorization: Bearer <token>`, `Otari-Key: <token>` or
`x-api-key: <token>` (`docs/api-reference.md:42-56`). A management route called
with an API key answers `401 {"detail": "Invalid master key"}`
(`docs/api-reference.md:71-76`).

The drill key Fire Drill mints is a third, short-lived API key ("drill key").

## Q1. How is a routing policy read over the API?

**Confirmed: `GET /api/v1/routing/policies`, master key only.**

- Router gated by `require_deployment_operator` (`src/gateway/api/routes/routing.py:55`).
- Handler `list_policies` (`routing.py:348-398`) returns stored policies **and**
  config-file policies (merged at `routing.py:387-393`, `source: "config"`).
  Optional `?workspace_id=` narrows stored rows only.
- Response item `PolicyResponse`: `name`, `spec`, `source`, `workspace_id`,
  `user_id`, `is_dynamic` (spec `components.schemas.PolicyResponse`).
- `spec` is the same shape as a `routing.policies` entry in `config.yml`
  (`src/gateway/models/routing.py:343` `PolicySpec`):
  - `select`: ordered list of `SelectEntry` (`models/routing.py:185`), each with
    exactly one of `target` (with a `when` clause), `default` (must be last), or
    `router` (`weighted` / `priority`, with `candidates` and `weights`).
  - `on_failure`: ordered list of selectors.
  - `guardrails`: mandatory input guardrails.
  - At most 5 candidates in total (`docs/routing.md:321-322`), selectors must be
    concrete `provider:model` / `instance:model`, no chaining (`routing.md:323-324`).
- Also available: `POST /api/v1/routing/policies/explain` (`routing.py:604`,
  operator-gated) compiles a plan without dispatching and returns ordered
  `candidates` (`position`, `instance`, `model`, `dispatch_model`) plus `dropped`
  candidates with reasons. It only lists the conditional `when` targets that match
  the simulated budget state, so it is not enough on its own to enumerate every leg.

**Without the master key** the policy cannot be read: a member's org-scoped read
`/api/v1/organizations/me/routing-policies` needs a dashboard session, not an API
key (`docs/routing.md:296-303`). Fallbacks, in order: `--legs a,b,c`, then
`--config <path>` parsing `routing.policies.<alias>` from the Otari `config.yml`
(format: `docs/routing.md:17-25`, `64-75`, `111-126`).

**Leg roles, as Fire Drill will derive them from `spec`:**

| Spec element | Role label |
| --- | --- |
| `select[*].default` | `primary` |
| `select[*].target` with `when` (budget conditions) | `tier-down n` |
| `select[*].target` with `when` (`user_id` / `key_id`) | `conditional n` |
| `select[*].router` candidates | `weighted n` / `priority n` (the default is the last resort) |
| `on_failure[i]` | `failover i+1` |

Duplicates are dropped (a selector keeps its first role).

## Q2. Users, virtual keys and budgets over the API

All master key (`require_deployment_operator` on each router).

| Action | Call | Reference |
| --- | --- | --- |
| Create budget | `POST /api/v1/budgets` `{name, max_budget, budget_duration_sec?, request_limit?}` -> `BudgetResponse.budget_id` | `routes/budgets.py:25-27, 69`; spec `CreateBudgetRequest` |
| Delete budget | `DELETE /api/v1/budgets/{budget_id}` -> 204; **409** while a scoped ceiling or workspace default names it; users on it become uncapped | `routes/budgets.py:277-294` |
| Create user | `POST /api/v1/users` `{user_id, budget_id, allowed_models}` | `routes/users.py:41-43, 220`; spec `CreateUserRequest` |
| Delete user | `DELETE /api/v1/users/{user_id}` -> 204. Soft delete; **also deactivates every key of that user**; erases telemetry and traces but not usage rows | `routes/users.py:430-463`, `routes/_helpers.py:385` |
| Create key | `POST /api/v1/keys` `{key_name, user_id, allowed_models, expires_at, workspace_id, metadata}` -> `CreateKeyResponse` with `id` and the secret `key` (shown once) | `routes/keys.py:46-48, 106, 304-445` |
| Revoke key | `DELETE /api/v1/keys/{key_id}` -> 204 (hard delete) | `routes/keys.py:614-631` |
| Disable key | `PATCH /api/v1/keys/{key_id}` `{is_active: false}` | `routes/keys.py:490` |
| Per-key ceiling | `POST /api/v1/scoped-budgets` `{scope_type: "api_token", scope_id: <key id>, budget_id}`; `DELETE /api/v1/scoped-budgets/{id}` | `routes/scoped_budgets.py:41-47, 59-69, 116` |

**Important:** a key created without `user_id` is attached to the shared `default`
user and shares its budget and usage (`routes/keys.py:317-320, 366-369`). So the
drill must create its own user.

**Fire Drill mint plan** (all master key):

1. `POST /api/v1/budgets` `{name: "firedrill-<run>", max_budget: <--budget>}`
2. `POST /api/v1/users` `{user_id: "firedrill-<run>", budget_id, allowed_models: <legs>}`
3. `POST /api/v1/keys` `{key_name: "firedrill-<run>", user_id, allowed_models: <legs>, expires_at: now + ttl, workspace_id: <policy's workspace, if stored>}`

**Cleanup**, in a `finally` and on SIGINT/SIGTERM, each step attempted even if an
earlier one fails: `DELETE /keys/{id}` -> `DELETE /users/{user_id}` (deactivates
any key left behind) -> `DELETE /budgets/{id}` (must come last, after the user no
longer needs it).

The budget is a per-user budget, which is enforced (`src/gateway/AGENTS.md`,
"Budget enforcement"; `docs/routing.md:86-92`). A budget-exempt key would skip it,
so Fire Drill never sets `exclude_from_budget`.

## Q3. Model allow-list and expiry on a key

**Both confirmed.**

- `allowed_models`: `null` = any, `[]` = none, or canonical `instance:model`
  entries with `instance:*` wildcards (spec `CreateKeyRequest.allowed_models`;
  `docs/api-keys.md:118-123`). A key can narrow its user's list, never widen it
  (`routes/keys.py:372-375`). Caller allow-lists apply to every routing candidate
  (`docs/routing.md:329`).
- `expires_at`: optional ISO timestamp on create and patch (spec
  `CreateKeyRequest.expires_at`). Enforced at authentication: an expired key
  answers 401 "API key has expired" (`src/gateway/services/api_keys/_admission.py:15-19`).
  **No minimum** is enforced in the code I read, so "shortest available" is
  whatever we choose. Plan: `now + max(5 min, estimated drill time x 3)`, capped at
  60 min.

## Q4. Does the usage/activity log store request bodies?

**Metadata only, by default.**

- `UsageLog` (`src/gateway/models/usage.py:32-234`) holds ids, model, provider,
  endpoint, token counts, cost and pricing fields, status, `error_message`,
  `status_code`, latencies, `policy_name`, `attempt_position`, `request_group_id`,
  and request `tags`. No prompt or completion columns.
- Bodies can be stored elsewhere when a workspace turns on agent session content
  / trace content, for idempotency-keyed requests, or for saved Playground
  conversations (`docs/privacy/data-collection.md:19`; `WorkspacePublic.trace_content_enabled`).
- Consequence: drill prompts are not kept in the usage log unless the workspace
  has trace content on. `error_message` may carry a provider's error text.
  Fire Drill sends no idempotency key and tags requests through `metadata`
  (`firedrill_run`, `firedrill_leg`, `firedrill_sample`) so the drill can be
  filtered in the dashboard and in `GET /api/v1/usage?tag=...` (`docs/api-reference.md:280-341`).

## Q5. Which field identifies the model that actually served a response?

**The `Otari-Provider` and `Otari-Model` response headers, not the body.**

- The body's `model` keeps the requested name (policy, alias or catalog id)
  (`docs/routing.md:28`, `335-336`).
- `Otari-Provider`: the provider instance by configured name. `Otari-Model`: the
  model id sent to that provider, without the instance prefix
  (`docs/routing.md:346-351`). Also `Otari-Attempt-Count`, `Otari-Fallback`,
  `Otari-Response-Duration-Ms`, `Server-Timing`, and `Otari-Request-ID`
  (`docs/api-reference.md:133-145`).
- Fire Drill check: `${Otari-Provider}:${Otari-Model}` must equal the leg. When
  the leg is a catalog spelling (`vendor/model`) Otari picks the provider, so the
  check relaxes to "`Otari-Model` matches the leg's model id" and the report notes it.

## Q6. How is per-request cost exposed?

**In the response body: `usage.cost_usd` (six-decimal USD string) plus
`usage.pricing_source`** (`docs/api-reference.md:149-160`). Both are absent on an
unpriced request. Headers `Otari-Cost-USD` exist only for `/audio/speech`
(`api-reference.md:183-190`).

Secondary sources:

- `GET /api/v1/usage/requests/{request_id}` (the drill key may read its own
  requests): settled `cost_usd` summed over all attempt rows. Returns 404 until the
  background writer has settled (`docs/api-reference.md:394-412`).
- `GET /api/v1/key/budget` (drill key): `remaining_usd` and every cap
  (`docs/api-reference.md:414-460`, `src/gateway/api/routes/calling_key.py:51-59`).

Fire Drill's client-side budget uses `usage.cost_usd`. When it is missing, it
falls back to `GET /api/v1/usage/requests/{id}`, and if that is still 404 it
counts the request at a pessimistic estimate (input tokens + `max_tokens` at the
model's price from `GET /api/v1/pricing`) so the running total never undercounts.

## Built-in tools and workspace policy

- `GET /api/v1/tools` (any API key, `src/gateway/api/routes/tools.py:50, 185`)
  returns `data[]` of `ManagedTool {id, available, reason, accepted_types, ...}`.
  With an API key, `available` already reflects that key's **workspace** policy
  (`reason: workspace_disabled`) (`docs/tools.md:19-33`). This lets preflight warn
  about web tools without the master key.
- `GET|PUT|DELETE /api/v1/workspaces/{workspace_id}/web-search`
  (`routes/workspace_web_search.py:26-67`, master key or session). Body
  `WorkspaceWebSearchConfigUpdate`: **one** `enabled` flag turns off
  `otari_web_search`, `otari_web_fetch` and `POST /api/v1/search` together, plus
  `max_results`, domain lists, `purpose_hint`, `provider_options`, executors
  (`docs/tools.md:888-923`). `GET` reports `configured` (a row exists) and
  `default_enabled`.
- `--lock-down` plan: `GET` and keep the old config; `PUT {enabled: false, ...rest unchanged}`;
  restore afterwards with `PUT <old values>` if `configured` was true, otherwise
  `DELETE` so the workspace returns to its default.
- Code execution policy: `/api/v1/workspaces/{workspace_id}/code-execution-policy`
  (`routes/workspace_code_execution_policy.py:22-66`; `docs/tools.md:642-666`).
- The workspace id for a key: `KeyInfo.workspace_id` from `GET /api/v1/keys/{id}`
  (master key). Fire Drill knows its drill key's id, so this works for the drill key.

## Corrections to the brief

1. **"Web tools cannot be combined with code execution or MCP servers in one
   request."** The current docs say the opposite: "One request may declare any mix
   of `otari_web_search`, `otari_web_fetch`, `otari_code_execution` and MCP
   servers" (`docs/tools.md:364-405`). This does not change Fire Drill: replays
   attach no web tools either way, and the `--run-code` path uses no web tools.
2. **Web search and fetch cannot be disabled separately** at the workspace level.
   It is one `enabled` switch (see above).
3. **There is a direct sandbox endpoint, `POST /api/v1/code/execute`**
   (`docs/api-reference.md:866-910`, `docs/tools.md:441-461`). It runs the
   submitted code in the gateway sandbox with no model involved and returns
   `{stdout, stderr, return_code}`. It is billed as an `otari_code_execution` call
   and honours the workspace code policy. **Proposal:** use it for `--run-code`
   instead of asking a model to "execute this verbatim" through
   `tools: [{"type": "otari_code_execution"}]`. It is deterministic (no chance that
   the model edits or skips the code), cheaper (no model tokens), and still runs
   only in the gateway sandbox. Keep the model-driven path as `--run-code=model` if
   you want the brief's original behaviour. Your call; I'll default to the direct
   endpoint unless you say otherwise.
4. **Fake leg: "registered in Otari as a provider endpoint" will not work.**
   Provider endpoints are explicitly not routing targets: "a routing policy that
   names one does not resolve it" (`docs/provider-endpoints.md:36-37`). The fake
   leg must be a **named provider instance** in `config.yml`:
   `providers: {fakeleg: {provider_type: openai, api_base: "http://host.docker.internal:<port>/v1", api_key: ...}}`
   (`docs/models.md:82-100`), reachable as `fakeleg:<model>`. It also needs a
   price (`pricing:` in `config.yml`, `docs/configuration.md:919-930`) because
   `require_pricing` defaults to `true` (`configuration.md:81`), and possibly
   `provider_allow_private_hosts` for a private address (`configuration.md:1714`).
   I'll confirm both on the live stack.

## Fidelity gaps (what a drill can and cannot reproduce)

Fire Drill replays each leg by sending `model: <leg selector>` directly. There is
no header that forces a policy onto a chosen candidate (`docs/routing.md:181-185`
only offers `Otari-Router: off`). Calling the leg directly differs from a real
failover in a few ways, which the README will list:

- The policy's **mandatory guardrails** are not applied (they attach to the policy,
  `docs/routing.md:187-208`). Organization guardrails still apply.
- In a multi-candidate plan Otari drops `reasoning_effort` for candidates that do
  not reason (`docs/routing.md:372-377`); a direct call sends it as given.
  Fire Drill will mirror that only if a later version reads models.dev data; for
  now the report notes it when the sample sets `reasoning_effort`.
- In a policy, each candidate gets one upstream call; a direct call gets the
  provider SDK's own retries (`docs/configuration.md:529-562`). This affects
  latency only.
- `response_format` is passed to every candidate unchanged in both cases
  (`docs/routing.md:375-377`), so schema failures reproduce faithfully.

## Local stack

- Compose: `docker compose up -d` from the Otari checkout, `--profile code-exec`
  for the sandbox (`docker-compose.yml:155-190`; `docs/self-hosted-quickstart.md`).
  The master key comes from `.env` (`self-hosted-quickstart.md:24-46`).
- Inference base URL is `http://localhost:8000/api/v1`; `/v1/...` without `/api`
  is a 404 (`docs/api-reference.md:8-31`). `--gateway` takes the host
  (`http://localhost:8000`) and Fire Drill appends `/api/v1`.
- Health: `GET /api/v1/health` -> `"status":"healthy"` (`self-hosted-quickstart.md:66-70`).
- This sandbox has the Docker CLI and `dockerd` but no running daemon. I'll try to
  start it for the live test and demo. If that fails, Otari can also run from
  source on SQLite (`scripts/oss_edition_smoke.py` does exactly that, per
  `AGENTS.md` "Test Notes"). Live provider legs need provider API keys, which this
  session does not have; anything that needs them will be marked UNVERIFIED.

## Gaps still open (to confirm on a live gateway)

- Whether a per-user budget with no `budget_duration_sec` enforces as a one-off
  cap (the schema allows null; the code path suggests yes).
- Whether `validate_allowed_models` (`routes/keys.py:328`) accepts catalog
  spellings (`vendor/model`) in a key allow-list, or only `instance:model`.
- How long `GET /api/v1/usage/requests/{id}` takes to stop returning 404 after a
  response.
- The exact error body when the drill key's budget is exhausted
  (`403 budget_exceeded` per `docs/budgets.md:141-143`), so the report can say
  "stopped by gateway budget" rather than "leg errored".
