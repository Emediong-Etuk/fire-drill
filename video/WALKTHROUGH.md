# Video 2: technical walkthrough (target 4 min, hard max 5 min)

Audience: Mozilla.ai engineers. Every command below was run on the demo stack
(`demo/run-demo.sh`, Otari `1726b58`, three real models via OpenRouter) and the expected
output is pasted from that run. Latencies, costs and the run id change per take.

Before recording, work through `video/CHECKLIST.md`, then open these in browser tabs:
`docs/architecture-components.svg`, `docs/architecture-sequence.svg`, and the Otari
dashboard signed in on **Overview → Requests**.

## Narration

| Time | Section | Line |
| --- | --- | --- |
| 0:00 | Architecture | Fire Drill is one Node CLI. No server, no database, and it talks to exactly one host: your Otari gateway. |
| 0:08 | | The CLI validates flags and registers every key as a secret before anything can print. |
| 0:15 | | The leg resolver reads the routing policy and turns it into ordered legs: primary, router pools, budget tier-downs, then the on_failure chain. |
| 0:26 | | The sample loader strips model, stream and user, keeps only function tools, and redacts secrets and emails. |
| 0:34 | | The contract deriver reads what each request already demands: a JSON schema, a JSON object, tool calls, or plain text. No tests to write. |
| 0:43 | | The replayer sends every sample down every leg, the checker validates each answer with ajv and against the primary, and the reporter prints the table. |
| 0:53 | | Every network call goes through one gateway client, which signs it with the user key, the admin key, or the drill key. |
| 1:01 | | From Otari it uses routing policies, virtual keys, budgets, usage tracking and the tools endpoint. |
| 1:10 | Request sequence | Here is one drill with trace on. Each line is one real gateway call, and none shows a key value. |
| 1:17 | | Step one is health, with no key. Step two lists built-in tools with the admin key. Step three reads the policy. |
| 1:25 | | Steps four to six mint the drill: a budget of fifty cents, a user on that budget with the legs as its allow-list, and a key that expires in minutes. |
| 1:36 | | Step seven asks for tools again with the drill key, which answers for its workspace. That is where the web-search warning comes from. |
| 1:44 | | Steps eight to twenty-two are the replays: primary first, three in flight, each signed by the drill key. The cost is usage dot cost USD from each response. |
| 1:56 | | Step twenty-three reads the key's budget back, so we can compare our running total with the gateway's. Here they match exactly. |
| 2:04 | | Steps twenty-four to twenty-six delete the key, the user and the budget, in that order. Deleting the user also disables any key it still holds. |
| 2:13 | | The admin calls cost nothing. Only the fifteen completions are billed, about a fortieth of a cent here. |
| 2:20 | | Now the gateway's side. Filter the Requests tab on the drill's user: fifteen rows, and an empty API key column, because the key is gone. |
| 2:32 | | The usage API says the same: fifteen requests, and the same total. |
| 2:38 | Safety | Budget is enforced twice. Otari refuses past the drill budget, and a client-side total reserves an estimate before each send and stops before the cap. |
| 2:48 | | The key is revoked in a finally block, on Ctrl-C, on SIGTERM and on a crash. If revoking fails, the exit code is two and the fix is printed. |
| 2:57 | | Replays never carry web tools or MCP servers, and model output is never executed locally. Lint fails the build if the source imports child process or vm. |
| 3:07 | Tests | Here is the suite: seventy-nine tests in about nine seconds. |
| 3:12 | | The integration tests run whole drills against a fake Otari in the test process. Same routes, same shapes: a good leg, a bad-JSON leg and a broken leg. |
| 3:22 | | These two spawn the real CLI, send SIGINT or SIGTERM mid-replay, and check the key, the user and the budget were deleted. |
| 3:30 | | The secrets test runs with canary keys while the fake gateway echoes the token back in errors, and greps every byte of output for them. |
| 3:38 | | And this one runs against a real Otari when FIREDRILL_LIVE is one. It then lists the gateway's keys to prove none is left. |
| 3:46 | | Not covered: streaming, the Messages and Responses APIs, and the config-file fallback against a real gateway. |
| 3:53 | Limits | One limit matters most. Otari has no header to force a policy onto one candidate, so Fire Drill calls each leg directly. The policy's mandatory guardrails don't run on a drill. |
| 4:05 | | Next: Messages and Responses, comparing answers by meaning, not just shape, and recording samples from live traffic. |

Word count: 636.

## Shot list

| Time | On screen |
| --- | --- |
| 0:00 to 1:10 | `docs/architecture-components.svg` full screen in the browser. Point at each box as it is named: CLI, Leg resolver, Sample loader, Contract deriver, Replayer, Checker, Reporter, Gateway client, then the Otari box. |
| 1:10 | Terminal. Type command 1. Let it finish, then scroll to the top of the trace. |
| 1:17 to 2:13 | The trace lines, highlighted in order: 01-03, 04-06, 07, 08-22 (point at the `cost` and `signed by` columns), 23, 24-26. Optionally cut to `docs/architecture-sequence.svg` for 2 seconds at 1:25. |
| 2:20 | Browser, Otari **Overview → Requests**. Open the **User** filter and pick `Fire Drill <run id>` (the run id is on trace line 25). Show 15 rows; point at the empty API key column. Click a Gemma row: the detail panel shows user, cost and request ID, no prompt text. |
| 2:32 | Terminal. Type command 2. |
| 2:38 to 3:07 | `README.md`, section "Safety model", in the browser or editor. At 2:57 show `eslint.config.js` lines with `no-restricted-imports`. |
| 3:07 | Terminal. Type command 3, then command 4. |
| 3:12 to 3:30 | The verbose list from command 4; highlight the "on SIGINT", "on SIGTERM" and "secrets" lines. |
| 3:38 | Type command 5. |
| 3:53 | `README.md`, section "Limitations". |
| 4:05 | `README.md`, section "Roadmap", then the repo URL. |

## Commands, in order, with expected output

Off camera (CHECKLIST.md):

```bash
export OTARI_BASE_URL=http://localhost:8000
```

```bash
export OTARI_ADMIN_KEY="$(grep ^OTARI_MASTER_KEY= demo/.env | cut -d= -f2-)"
```

**Command 1:**

```bash
firedrill demo-chat --samples demo/samples.jsonl --trace
```

```text
step method path (under /api/v1)             status latency  cost      signed by
[01] GET    /health                          200       39ms  -         no key
[02] GET    /tools                           200      102ms  -         admin key
[03] GET    /routing/policies                200       75ms  -         admin key
[04] POST   /budgets                         200       16ms  -         admin key
[05] POST   /users                           200       17ms  -         admin key
[06] POST   /keys                            200       29ms  -         admin key
[07] GET    /tools                           200       25ms  -         drill key
Drilling "demo-chat" on http://localhost:8000: 1. openrouter:openai/gpt-4o-mini  2. openrouter:google/gemma-3-12b-it  3. openrouter:mistralai/mistral-small-3.2-24b-instruct
[08] POST   /chat/completions                200       1.1s  $0.000019 drill key  leg 1 sample 2
[09] POST   /chat/completions                200       1.5s  $0.000027 drill key  leg 1 sample 3
[10] POST   /chat/completions                200       1.6s  $0.000030 drill key  leg 1 sample 1
[11] POST   /chat/completions                200      864ms  $0.000022 drill key  leg 1 sample 4
[12] POST   /chat/completions                200       1.1s  $0.000035 drill key  leg 1 sample 5
[13] POST   /chat/completions                200      648ms  $0.000005 drill key  leg 2 sample 2
[14] POST   /chat/completions                200      958ms  $0.000007 drill key  leg 2 sample 1
[15] POST   /chat/completions                200       1.1s  $0.000009 drill key  leg 2 sample 5
[16] POST   /chat/completions                200       2.2s  $0.000011 drill key  leg 2 sample 3
[17] POST   /chat/completions                200       1.5s  $0.000019 drill key  leg 2 sample 4
[18] POST   /chat/completions                200      788ms  $0.000009 drill key  leg 3 sample 2
[19] POST   /chat/completions                200      790ms  $0.000016 drill key  leg 3 sample 3
[20] POST   /chat/completions                200       1.5s  $0.000014 drill key  leg 3 sample 1
[21] POST   /chat/completions                200      866ms  $0.000012 drill key  leg 3 sample 4
[22] POST   /chat/completions                200      901ms  $0.000012 drill key  leg 3 sample 5
[23] GET    /key/budget                      200       16ms  -         drill key
[24] DELETE /keys/20be9679…                  204       24ms  -         admin key
[25] DELETE /users/firedrill-20261110-b4911d 204       41ms  -         admin key
[26] DELETE /budgets/ded4c529…               204       25ms  -         admin key

Fire Drill: "demo-chat"  5 samples x 3 legs x 1 run

#  Role        Model                                        Pass       Failures            p50     $/req     $/1k
1  primary     openrouter:openai/gpt-4o-mini                5/5 100%   -                  1.1s $0.000027  $0.0266
2  failover 1  openrouter:google/gemma-3-12b-it             4/5 80%    tool 1             1.1s $0.000010  $0.0102
3  failover 2  openrouter:…/mistral-small-3.2-24b-instruct  5/5 100%   -                 866ms $0.000013  $0.0126

Failures
  leg 2  sample 4  tool  "get_weather" arguments break its schema: missing "city"; missing "unit"
      "{}"

! Web search or fetch is enabled in this workspace. Replays never attach web tools, but your app's real requests might.

Spent $0.000247 of $0.50 (gateway recorded $0.000247). Drill key revoked. 7.0s.
Leg 2 fails 1/5 tool-call checks. Move it below leg 3 or remove it.
```

**Command 2** (replace the user id with the one on your trace line 25):

```bash
curl -s "$OTARI_BASE_URL/api/v1/usage?user_id=firedrill-20261110-b4911d" -H "Authorization: Bearer $OTARI_ADMIN_KEY" | jq '[.[] | .cost] | {requests: length, total_cost: add}'
```

```text
{
  "requests": 15,
  "total_cost": 0.000247
}
```

**Command 3:**

```bash
npm test
```

Expected ending (the build lines above it are tsup's):

```text
 Test Files  9 passed | 1 skipped (10)
      Tests  79 passed | 1 skipped (80)
   Start at  22:35:24
   Duration  8.54s (tests 93%, import 5%, transform 1%)
```

The skipped file is the live test, which needs `FIREDRILL_LIVE=1` (command 5).

**Command 4:**

```bash
npx vitest run test/integration.test.ts --reporter=verbose
```

```text
✓ test/integration.test.ts > a drill against a policy with a broken and a bad-JSON leg > reports each leg, recommends a change, exits 1 and revokes the key 1486ms
✓ test/integration.test.ts > a drill against a policy with a broken and a bad-JSON leg > replays on the drill key only, never the admin or user key 1332ms
✓ test/integration.test.ts > exit codes > exits 0 when every leg passes 23ms
✓ test/integration.test.ts > exit codes > honours --fail-under 22ms
✓ test/integration.test.ts > exit codes > exits 2 with the fix when the gateway is down 6ms
✓ test/integration.test.ts > exit codes > exits 2 and still revokes the key when the drill fails after minting 12ms
✓ test/integration.test.ts > budget enforcement > stops when the gateway refuses on the drill key's budget, and reports what was not sent 17ms
✓ test/integration.test.ts > budget enforcement > enforces the cap client-side on an existing key 10ms
✓ test/integration.test.ts > secrets > never prints the user, admin or drill key, even when the gateway echoes one 4553ms
✓ test/integration.test.ts > on SIGINT > stops the drill, revokes the key and exits 2 266ms
✓ test/integration.test.ts > on SIGTERM > stops the drill, revokes the key and exits 2 274ms
Tests  11 passed (11)
```

(Shown without leading spaces; vitest indents them.)

**Command 5:**

```bash
FIREDRILL_LIVE=1 FIREDRILL_LIVE_ALIAS=demo-chat npm run test:live
```

Expected ending:

```text
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

## Safe to show

- Otari dashboard: **Overview** (Usage and Requests tabs), the request detail panel,
  **API keys**, **Routing**. Checked on the demo stack: none of them shows a key value
  or prompt text. The API keys page shows a four-character fingerprint of the
  bootstrap key (for example `(hWN-)`), which is not usable on its own.
- Not safe: `docker compose logs otari` (Otari prints its bootstrap key there on first
  start), `demo/.env`, the **Hosted providers** page (it shows the last four characters
  of provider keys), and the dashboard sign-in screen while typing.
