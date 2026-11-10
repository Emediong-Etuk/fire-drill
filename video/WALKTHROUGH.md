# Video 2: technical walkthrough (target 4 min, hard max 5 min)

Audience: Mozilla.ai engineers. Every command below was run on the demo stack
(`demo/run-demo.sh`, Otari `1726b58`, three real models via OpenRouter, Otari's code
sandbox) and the expected output is pasted from that run. Latencies, costs, ids and the
order of concurrent replay lines change per take.

Before recording, work through `video/CHECKLIST.md`, then open these in browser tabs:
`docs/architecture-components.svg`, `docs/architecture-sequence.svg`, and the Otari
dashboard signed in on **Overview → Requests**.

## Narration

| Time | Section | Line |
| --- | --- | --- |
| 0:00 | Architecture | Fire Drill is one Node CLI. No server, no database, and it talks to exactly one host: your Otari gateway. |
| 0:08 | | The CLI validates flags and registers every key as a secret before anything can print. |
| 0:14 | | The leg resolver turns the routing policy into ordered legs: primary, router pools, budget tier-downs, then the failover chain. |
| 0:23 | | The sample loader strips model, stream and user, keeps only function tools, and redacts secrets and emails. |
| 0:31 | | The contract deriver reads what each request already demands: a JSON schema, a JSON object, tool calls, or text. No tests to write. |
| 0:40 | | The replayer sends every sample down every leg. The checker validates each answer with ajv and against the primary. The reporter prints the table. |
| 0:50 | | One gateway client makes every call, signed with the user key, the admin key or the drill key. |
| 0:57 | | From Otari: routing policies give the legs. Virtual keys and budgets fence the drill. Usage tracking gives cost. Code execution runs generated Python. Workspace policies switch web tools off. |
| 1:10 | Request sequence | Here is one drill with trace on, plus run-code and lock-down. Each line is one real gateway call. None shows a key. |
| 1:18 | | One is health, with no key. Two lists built-in tools with the admin key. Three reads the policy. |
| 1:25 | | Four to six mint the drill: a fifty-cent budget, a user on it with the legs as its allow-list, and a key that expires in minutes. |
| 1:34 | | Seven to eleven are lock-down: find the key's workspace, save its web policy, switch search and fetch off, and confirm with the drill key. |
| 1:44 | | Twelve to twenty-nine are the replays: primary first, three in flight, all on the drill key. Cost is usage dot cost USD from each response. |
| 1:54 | | Thirty reads the sandbox price. Thirty-one to thirty-three run each leg's Python in Otari's sandbox. Never on this machine. |
| 2:03 | | Thirty-four reads the key's budget back, and it matches our running total. Thirty-five restores the web policy. The last three delete the key, the user and the budget. |
| 2:14 | | Admin calls are free. The bill is eighteen completions and three sandbox runs: a third of a cent. |
| 2:21 | | Now the gateway's side. Filter Requests on the drill's user: twenty-one rows, and an empty API key column, because the key is gone. |
| 2:31 | | The usage API agrees: eighteen completions, three code runs, the same total. |
| 2:37 | Safety | Budget is enforced twice: Otari refuses past the drill budget, and a client-side total reserves before each send and stops before the cap. |
| 2:46 | | The key is revoked in a finally block, on Ctrl-C, on SIGTERM and on a crash. If revoking fails, the exit code is two and the fix is printed. |
| 2:55 | | Replays never carry web tools or MCP servers. Model output never runs locally. Lint fails the build if the source imports child process or vm. |
| 3:05 | Tests | The suite: ninety-one tests in about nine seconds. |
| 3:09 | | The integration tests run whole drills against a fake Otari: same routes, same shapes, with a good leg, a bad-JSON leg and a broken leg. |
| 3:18 | | These two spawn the real CLI, send SIGINT or SIGTERM mid-replay, and check the key, user and budget were deleted. |
| 3:26 | | The secrets test uses canary keys, makes the fake gateway echo the token in errors, and greps all output, trace included. |
| 3:34 | | This one runs against a real Otari when FIREDRILL_LIVE is one, then lists the gateway's keys to prove none is left. |
| 3:42 | | Not covered: streaming, the Messages and Responses APIs, and the config-file fallback against a real gateway. |
| 3:49 | Limits | The main limit: Otari has no header to force a policy onto one candidate, so Fire Drill calls each leg directly, and the policy's mandatory guardrails don't run. |
| 3:59 | | Next: Messages and Responses, comparing answers by meaning, not just shape, and replaying streamed responses. |

Word count: 611.

## Shot list

| Time | On screen |
| --- | --- |
| 0:00 to 1:10 | `docs/architecture-components.svg` full screen. Point at each box as it is named: CLI, Leg resolver, Sample loader, Contract deriver, Replayer, Checker, Reporter, Gateway client, then the Otari box. |
| 1:10 | Terminal. Type command 1. Let it finish (about 13 s), then scroll to the top of the trace. |
| 1:18 to 2:14 | Trace lines highlighted in order: 01-03, 04-06, 07-11, 12-29 (point at the `cost` and `signed by` columns), 30-33, 34-38. Optionally cut to `docs/architecture-sequence.svg` for 2 seconds at 1:25. |
| 2:21 | Browser, Otari **Overview → Requests**. **User** filter: pick `Fire Drill <run id>` (the run id is on trace line 37). Show the rows; point at the empty API key column. Click a Gemma row: the detail panel shows user, cost and request ID, no prompt text. |
| 2:31 | Terminal. Type command 2. |
| 2:37 to 3:05 | `README.md`, section "Safety model". At 2:55 show `eslint.config.js`, the `no-restricted-imports` block. |
| 3:05 | Terminal. Type command 3, then command 4. |
| 3:09 to 3:34 | The verbose list from command 4; highlight "on SIGINT", "on SIGTERM" and "secrets". |
| 3:34 | Type command 5. |
| 3:49 | `README.md`, section "Limitations". |
| 3:59 | `README.md`, section "Roadmap", then the repo URL. |

## Commands, in order, with expected output

Off camera (CHECKLIST.md), after `demo/reset.sh`:

```bash
export OTARI_BASE_URL=http://localhost:8000
```

```bash
export OTARI_ADMIN_KEY="$(grep ^OTARI_MASTER_KEY= demo/.env | cut -d= -f2-)"
```

**Command 1** (`demo/walkthrough-samples.jsonl` is the pitch's five samples plus one that
asks for Python):

```bash
firedrill demo-chat --samples demo/walkthrough-samples.jsonl --run-code --lock-down --trace
```

```text
step method path (under /api/v1)             status latency  cost      signed by
[01] GET    /health                          200       32ms  -         no key
[02] GET    /tools                           200      141ms  -         admin key
[03] GET    /routing/policies                200       69ms  -         admin key
[04] POST   /budgets                         200       22ms  -         admin key
[05] POST   /users                           200       16ms  -         admin key
[06] POST   /keys                            200       30ms  -         admin key
[07] GET    /tools                           200       26ms  -         drill key
[08] GET    /keys/3f6e2fcf…                  200       10ms  -         admin key
[09] GET    /workspaces/a68f29ea…/web-search 200       14ms  -         admin key
[10] PUT    /workspaces/a68f29ea…/web-search 200       22ms  -         admin key
[11] GET    /tools                           200       12ms  -         drill key
Drilling "demo-chat" on http://localhost:8000: 1. openrouter:openai/gpt-4o-mini  2. openrouter:google/gemma-3-12b-it  3. openrouter:mistralai/mistral-small-3.2-24b-instruct
[12] POST   /chat/completions                200       1.1s  $0.000019 drill key  leg 1 sample 2
[13] POST   /chat/completions                200       1.3s  $0.000030 drill key  leg 1 sample 1
[14] POST   /chat/completions                200       1.4s  $0.000027 drill key  leg 1 sample 3
[15] POST   /chat/completions                200       1.2s  $0.000022 drill key  leg 1 sample 4
[16] POST   /chat/completions                200       1.1s  $0.000020 drill key  leg 1 sample 5
[17] POST   /chat/completions                200       2.0s  $0.000063 drill key  leg 1 sample 6
[18] POST   /chat/completions                200      897ms  $0.000005 drill key  leg 2 sample 2
[19] POST   /chat/completions                200       1.3s  $0.000011 drill key  leg 2 sample 3
[20] POST   /chat/completions                200      805ms  $0.000019 drill key  leg 2 sample 4
[21] POST   /chat/completions                200       1.9s  $0.000010 drill key  leg 2 sample 1
[22] POST   /chat/completions                200       1.3s  $0.000009 drill key  leg 2 sample 5
[23] POST   /chat/completions                200      667ms  $0.000009 drill key  leg 3 sample 2
[24] POST   /chat/completions                200       1.5s  $0.000016 drill key  leg 3 sample 1
[25] POST   /chat/completions                200      726ms  $0.000018 drill key  leg 3 sample 4
[26] POST   /chat/completions                200      877ms  $0.000016 drill key  leg 3 sample 3
[27] POST   /chat/completions                200       1.4s  $0.000035 drill key  leg 3 sample 6
[28] POST   /chat/completions                200       3.9s  $0.000028 drill key  leg 2 sample 6
[29] POST   /chat/completions                200       4.6s  $0.000012 drill key  leg 3 sample 5
[30] GET    /pricing/otari:code_execution    200       16ms  -         drill key
[31] POST   /code/execute                    200      202ms  $0.0010   drill key  leg 2 sample 6
[32] POST   /code/execute                    200      210ms  $0.0010   drill key  leg 1 sample 6
[33] POST   /code/execute                    200      215ms  $0.0010   drill key  leg 3 sample 6
[34] GET    /key/budget                      200       14ms  -         drill key
[35] DELETE /workspaces/a68f29ea…/web-search 200       13ms  -         admin key
[36] DELETE /keys/3f6e2fcf…                  204       17ms  -         admin key
[37] DELETE /users/firedrill-20261110-403274 204       44ms  -         admin key
[38] DELETE /budgets/c041332f…               204       25ms  -         admin key

Fire Drill: "demo-chat"  6 samples x 3 legs x 1 run

#  Role        Model                                        Pass       Failures            p50     $/req     $/1k
1  primary     openrouter:openai/gpt-4o-mini                6/6 100%   -                  1.2s $0.000030  $0.0302
2  failover 1  openrouter:google/gemma-3-12b-it             5/6 83%    tool 1             1.3s $0.000014  $0.0137
3  failover 2  openrouter:…/mistral-small-3.2-24b-instruct  6/6 100%   -                  1.1s $0.000018  $0.0177

Failures
  leg 2  sample 4  tool  "get_weather" arguments break its schema: missing "unit"
      "{"city": "Lag{}"}"

! Web search and fetch were switched off for the drill (--lock-down) and switched back on afterwards.

Spent $0.0034 of $0.50 (gateway recorded $0.0034). Drill key revoked. 12.9s.
Leg 2 fails 1/6 tool-call checks. Move it below leg 3 or remove it.
```

Line 35 is a `DELETE` because the demo workspace had no stored web policy: deleting
returns it to the default. A workspace with a stored policy gets a `PUT` of its old
values instead.

**Command 2** (put the user id from your trace line 37 in place of the one below):

```bash
curl -s "$OTARI_BASE_URL/api/v1/usage?user_id=firedrill-20261110-403274" -H "Authorization: Bearer $OTARI_ADMIN_KEY" | jq '{requests: length, by_endpoint: (group_by(.endpoint) | map({(.[0].endpoint): length}) | add), total_cost: (([.[] | .cost] | add) * 1e6 | round / 1e6)}'
```

```text
{
  "requests": 21,
  "by_endpoint": {
    "/v1/chat/completions": 18,
    "/v1/code/execute": 3
  },
  "total_cost": 0.003369
}
```

**Command 3:**

```bash
npm test
```

Expected ending (tsup's build lines come first):

```text
 Test Files  11 passed | 1 skipped (12)
      Tests  91 passed | 1 skipped (92)
   Duration  8.77s (tests 90%, import 8%, transform 1%, worker 1%)
```

The skipped file is the live test, which needs `FIREDRILL_LIVE=1` (command 5).

**Command 4:**

```bash
npx vitest run test/integration.test.ts --reporter=verbose
```

```text
✓ test/integration.test.ts > a drill against a policy with a broken and a bad-JSON leg > reports each leg, recommends a change, exits 1 and revokes the key 1351ms
✓ test/integration.test.ts > a drill against a policy with a broken and a bad-JSON leg > replays on the drill key only, never the admin or user key 1499ms
✓ test/integration.test.ts > exit codes > exits 0 when every leg passes 31ms
✓ test/integration.test.ts > exit codes > honours --fail-under 26ms
✓ test/integration.test.ts > exit codes > exits 2 with the fix when the gateway is down 7ms
✓ test/integration.test.ts > exit codes > exits 2 and still revokes the key when the drill fails after minting 16ms
✓ test/integration.test.ts > budget enforcement > stops when the gateway refuses on the drill key's budget, and reports what was not sent 20ms
✓ test/integration.test.ts > budget enforcement > enforces the cap client-side on an existing key 11ms
✓ test/integration.test.ts > secrets > never prints the user, admin or drill key, even when the gateway echoes one 4263ms
✓ test/integration.test.ts > on SIGINT > stops the drill, revokes the key and exits 2 271ms
✓ test/integration.test.ts > on SIGTERM > stops the drill, revokes the key and exits 2 293ms
Tests  11 passed (11)
```

(Shown without vitest's indentation.)

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
