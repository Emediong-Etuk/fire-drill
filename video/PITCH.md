# Video 1: pitch (target 90 s, hard max 2 min)

Audience: judges who have not read the repo. No architecture, no code, no test output.

Before you record, work through `video/CHECKLIST.md`. It ends with `demo/reset.sh`, the
two `export` lines below, the dashboard signed in on the **API keys** page, and a clear
terminal in `fire-drill/`.

## Narration (228 words)

| Time | Line |
| --- | --- |
| 0:00 | If your app or coding agent calls models through Otari, you probably have a routing policy. |
| 0:05 | One model name, with a primary model and cheaper or backup models behind it. |
| 0:12 | Those backup legs only run when the primary has an outage, or a budget cap kicks in. |
| 0:19 | So the first time your app meets the cheaper model is in production, on the worst day. |
| 0:26 | This problem only exists because the gateway puts several models behind one name. Your tests only ever hit the primary. |
| 0:35 | Fire Drill runs your real requests down every leg, ahead of time. One command. |
| 0:41 | It reads the policy from Otari, mints a throwaway key with its own budget, and replays five requests per leg. |
| 0:50 | Legs one and three are real models. Both pass every check. |
| 0:55 | Leg two is Gemma 3 12B, also real. It breaks a tool call: it calls get_weather without the required unit. |
| 1:04 | For each leg I get the pass rate, latency, and the cost per request and per thousand. |
| 1:11 | And one line that tells me what to change: move leg two below leg three, or remove it. |
| 1:17 | The exit code is one, so this would fail a CI job. |
| 1:21 | The drill key is already gone. In Otari's key list, only the bootstrap key is left. |
| 1:27 | Fire Drill is open source. Clone it, install it, and run firedrill with your policy name. |

## Shot list

| Time | On screen |
| --- | --- |
| 0:00 to 0:35 | Title card: "Fire Drill: rehearse your Otari fallback routes". At 0:05 add one line under it: `demo-chat → gpt-4o-mini, then gemma-3-12b, then mistral-small-3.2-24b`. |
| 0:35 | Terminal, full screen, prompt empty. Type command 1. |
| 0:41 | The drill runs; the "Drilling" line lists the three legs. |
| 0:50 | The table appears. Highlight rows 1 and 3 (green 100%). |
| 0:55 | Highlight row 2 (red 80%, `tool 1`) and the Failures block: `missing "unit"` and the `{"city": "Lag{}"}` excerpt. |
| 1:04 | Highlight the `p50`, `$/req` and `$/1k` columns. |
| 1:11 | Highlight the last line, the recommendation. |
| 1:17 | Type command 2; `1` appears. |
| 1:21 | Switch to the browser: Otari dashboard, **API keys** page, press refresh. One row: `bootstrap`. |
| 1:27 | End card: `github.com/Emediong-Etuk/fire-drill` and the one-line quickstart below. |

End card quickstart (verified from a fresh clone):

```text
git clone https://github.com/Emediong-Etuk/fire-drill && cd fire-drill && npm ci && npm install -g . && firedrill <your-policy>
```

## Commands, in order, with expected output

Set up off camera (CHECKLIST.md). These two lines put the gateway URL and the master
key in your shell without printing the key:

```bash
export OTARI_BASE_URL=http://localhost:8000
```

```bash
export OTARI_ADMIN_KEY="$(grep ^OTARI_MASTER_KEY= demo/.env | cut -d= -f2-)"
```

**Command 1** (on camera):

```bash
firedrill demo-chat --samples demo/samples.jsonl
```

Expected output, from a real run on the demo stack (latencies and costs vary slightly
per take; the pass/fail pattern and the recommendation did not change across the 30+
runs made while building this):

```text
Drilling "demo-chat" on http://localhost:8000: 1. openrouter:openai/gpt-4o-mini  2. openrouter:google/gemma-3-12b-it  3. openrouter:mistralai/mistral-small-3.2-24b-instruct

Fire Drill: "demo-chat"  5 samples x 3 legs x 1 run

#  Role        Model                                        Pass       Failures            p50     $/req     $/1k
1  primary     openrouter:openai/gpt-4o-mini                5/5 100%   -                  1.1s $0.000026  $0.0256
2  failover 1  openrouter:google/gemma-3-12b-it             4/5 80%    tool 1            848ms $0.000010  $0.0100
3  failover 2  openrouter:…/mistral-small-3.2-24b-instruct  5/5 100%   -                 672ms $0.000013  $0.0132

Failures
  leg 2  sample 4  tool  "get_weather" arguments break its schema: missing "unit"
      "{"city": "Lag{}"}"

! Web search or fetch is enabled in this workspace. Replays never attach web tools, but your app's real requests might.

Spent $0.000244 of $0.50 (gateway recorded $0.000244). Drill key revoked. 5.7s.
Leg 2 fails 1/5 tool-call checks. Move it below leg 3 or remove it.
```

The run takes about 6 seconds. The narration from 0:41 to 0:50 covers it.

Gemma's broken arguments vary between takes. Seen so far: `missing "unit"` with the
excerpt `{"city": "Lag{}"}`, and `missing "city"; missing "unit"` with `{}`. The 0:55
line ("calls get_weather without the required unit") is true for both.

**Command 2** (on camera):

```bash
echo $?
```

Expected output:

```text
1
```

**Dashboard shot** (on camera): open `http://localhost:8000/#/keys` and refresh. Expected:
one row, `bootstrap`, status Active, owner `default`. No `firedrill-…` key.

The same check in the terminal, if you prefer it to the browser (also run on the demo
stack):

```bash
curl -s "$OTARI_BASE_URL/api/v1/keys" -H "Authorization: Bearer $OTARI_ADMIN_KEY" | jq -r '.[] | "\(.key_name)  active=\(.is_active)"'
```

```text
bootstrap  active=true
```

## If something differs on the day

- **Leg 2 passes.** Gemma's behaviour can change upstream. Run
  `FIREDRILL_DEMO_FAKE=1 demo/reset.sh` (with `OPENROUTER_API_KEY` set), and change the
  0:55 line to: "Leg two is a local stand-in that always answers in prose, so it breaks
  the JSON checks. I'm using it so this take is repeatable." Command 1 then prints (real
  run on the demo stack):

  ```text
  #  Role        Model                                        Pass       Failures            p50     $/req     $/1k
  1  primary     openrouter:openai/gpt-4o-mini                5/5 100%   -                  1.0s $0.000025  $0.0248
  2  failover 1  drillfake:prose-only                         1/5 20%    schema 3, tool 1   76ms $0.000005  $0.0046
  3  failover 2  openrouter:…/mistral-small-3.2-24b-instruct  5/5 100%   -                 886ms $0.000013  $0.0130

  Failures
    leg 2  samples 1-3  schema  output is not valid JSON
        "Sure! I'd be happy to help with that. Here is what I found: the details you asked for a…"
    leg 2  sample 4  tool  the primary leg called a tool here; this leg answered in text
        "Sure! I'd be happy to help with that. Here is what I found: the details you asked for a…"
  ...
  Leg 2 fails 3/5 schema checks. Move it below leg 3 or remove it.
  ```

  Run `demo/reset.sh` without the variable to go back to Gemma.
- **The web-search warning line.** It appears because Otari's default workspace allows
  web search. It is accurate and harmless; leave it in, or skip over it in narration.
- **No key list in the dashboard.** You are signed out: sign in with the master key
  before recording (CHECKLIST.md).
