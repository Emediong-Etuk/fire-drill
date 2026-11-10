# Architecture

Fire Drill is one CLI process with no server and no database. It talks to exactly one
host, the Otari gateway, and every call is signed by one of three credentials: the
**user key** (your API key), the **admin key** (Otari's master key) or the **drill
key** (minted for one run, then deleted).

The SVG exports (`architecture-components.svg`, `architecture-sequence.svg`) are
rendered from the `.mmd` sources in this folder with
[mermaid-cli](https://github.com/mermaid-js/mermaid-cli):
`mmdc -i architecture-sequence.mmd -o architecture-sequence.svg -b white`.

## Components

![Fire Drill components](architecture-components.svg)

```mermaid
flowchart LR
  dev(["Developer or CI job"]) --> cli["<b>CLI</b><br/>cli.ts · app.ts · options.ts"]

  subgraph FD["Fire Drill (one process, no server)"]
    direction TB
    cli --> pre["<b>Preflight</b><br/>gateway/tools.ts"]
    cli --> legs["<b>Leg resolver</b><br/>gateway/policy.ts"]
    cli --> key["<b>Drill key</b><br/>gateway/keys.ts"]
    cli --> load["<b>Sample loader</b><br/>samples.ts · redact.ts"]
    load --> derive["<b>Contract deriver</b><br/>contract/derive.ts"]
    cli --> replay["<b>Replayer</b><br/>replay.ts · budget.ts"]
    replay --> check["<b>Checker</b><br/>contract/check.ts"]
    derive --> check
    check --> report["<b>Reporter</b><br/>report/table.ts · trace.ts"]
    pre --> client
    legs --> client
    key --> client
    replay --> client["<b>Gateway client</b><br/>gateway/client.ts<br/>signs each call: user, admin or drill key"]
  end

  client -- "HTTPS to --gateway only" --> otari

  subgraph O["Otari gateway"]
    direction TB
    otari["/api/v1"] --- rp["Routing policies<br/>GET /routing/policies"]
    otari --- vk["Virtual keys + budgets<br/>/keys · /users · /budgets"]
    otari --- ut["Usage tracking<br/>usage.cost_usd · /key/budget"]
    otari --- bt["Built-in tools<br/>GET /tools"]
  end

  otari --> prov(["Model providers<br/>OpenAI · OpenRouter · ..."])
```

| Component | File | Job |
| --- | --- | --- |
| CLI | `src/cli.ts`, `src/app.ts`, `src/options.ts` | Parses flags, validates them with zod, registers every key as a secret before anything can print. |
| Gateway client | `src/gateway/client.ts` | The only code that does network I/O. Signs each call by credential type, refuses redirects, emits one trace event per call. |
| Preflight | `src/gateway/tools.ts` | `GET /api/v1/health` and `GET /api/v1/tools`; every failure names its fix. |
| Leg resolver | `src/gateway/policy.ts` | Policy spec to ordered legs with roles; `--legs` and `--config` fallbacks. |
| Drill key | `src/gateway/keys.ts` | Mints budget, user and key; revokes them in reverse, idempotently. |
| Sample loader | `src/samples.ts`, `src/redact.ts` | Validates request bodies, strips `model`/`stream`/`user`/non-function tools, redacts secrets and emails. |
| Contract deriver | `src/contract/derive.ts` | Reads what the request already demands: a JSON schema, a JSON object, tool calls, or text. |
| Replayer | `src/replay.ts`, `src/budget.ts` | Primary first, 3 in flight, 60 s timeout, one retry; the client-side budget reserves before each send. |
| Checker | `src/contract/check.ts` | ajv validation, tool-call checks against the primary, refusals, truncation, served model. |
| Reporter | `src/report/*.ts`, `src/trace.ts` | Table, grouped failures, recommendation, exit code, `--trace` lines. |

## One drill, call by call

![One drill, call by call](architecture-sequence.svg)

```mermaid
sequenceDiagram
  autonumber
  actor U as Developer
  participant FD as Fire Drill
  participant O as Otari
  participant P as Providers

  U->>FD: firedrill demo-chat
  FD->>O: GET /api/v1/health (no key)
  FD->>O: GET /api/v1/tools (admin key)
  FD->>O: GET /api/v1/routing/policies (admin key)
  O-->>FD: demo-chat: default + on_failure → 3 legs
  FD->>O: POST /api/v1/budgets {max_budget} (admin key)
  FD->>O: POST /api/v1/users {budget_id, allowed_models} (admin key)
  FD->>O: POST /api/v1/keys {allowed_models, expires_at} (admin key)
  O-->>FD: drill key (registered as a secret, never printed)
  FD->>O: GET /api/v1/tools (drill key): web tools on?
  loop every sample on every leg, primary first, 3 in flight
    FD->>O: POST /api/v1/chat/completions {model: leg} (drill key)
    O->>P: the leg's model
    P-->>O: completion
    O-->>FD: body + usage.cost_usd, Otari-Provider / Otari-Model
    Note over FD,O: check the contract, add the cost to the client-side total
  end
  FD->>O: GET /api/v1/key/budget (drill key): gateway-recorded spend
  FD->>O: DELETE /api/v1/keys/{id} (admin key)
  FD->>O: DELETE /api/v1/users/{id} (admin key)
  FD->>O: DELETE /api/v1/budgets/{id} (admin key)
  FD-->>U: report, recommendation, exit 0 / 1 / 2
```

| # | Call | Signed by | Costs |
| --- | --- | --- | --- |
| 1 | `GET /api/v1/health` | no key | nothing |
| 2 | `GET /api/v1/tools` | user key, or admin key when no user key is given | nothing |
| 3 | `GET /api/v1/routing/policies` | admin key | nothing |
| 4 | `POST /api/v1/budgets` | admin key | nothing |
| 5 | `POST /api/v1/users` | admin key | nothing |
| 6 | `POST /api/v1/keys` | admin key | nothing |
| 7 | `GET /api/v1/tools` | drill key | nothing |
| 8 to n | `POST /api/v1/chat/completions`, once per sample per leg per run | drill key | the model's price, as `usage.cost_usd`, charged to the drill budget |
| n+1 | `GET /api/v1/key/budget` | drill key | nothing |
| n+2 | `DELETE /api/v1/keys/{id}` | admin key | nothing |
| n+3 | `DELETE /api/v1/users/{id}` | admin key | nothing |
| n+4 | `DELETE /api/v1/budgets/{id}` | admin key | nothing |

`--trace` prints this list as it happens. A response without `usage.cost_usd` adds one
`GET /api/v1/usage/requests/{id}` (drill key) after the replays.
