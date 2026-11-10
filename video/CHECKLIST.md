# Pre-recording checklist

Do this once before each recording session, then the last block before each take.

## Screen and terminal

- [ ] Display at **1920x1080**. Record the full screen or a 1920x1080 window.
- [ ] Terminal font **18 pt or larger**. Check that the report table (113 characters
      wide) and `--trace` lines (under 100) fit without wrapping. At 18 pt a full-width
      terminal at 1920 px fits about 150 columns.
- [ ] Pick **one theme** (light or dark) for terminal, editor and browser, and keep it for
      both videos.
- [ ] A short prompt with no hostname, git status or key in it, for example
      `export PS1='$ '`.
- [ ] Notifications off (macOS Focus or Do Not Disturb, Slack and mail quit).
- [ ] Close every tab and window you will not show.

## Keys stay off screen

- [ ] Never type a key on camera. The only key-related lines you type are the two
      `export` lines below, and they print nothing.
- [ ] Shell history: start a fresh terminal, and run `export HISTCONTROL=ignorespace`
      (bash) or `setopt HIST_IGNORE_SPACE` (zsh). Prefix any line you do not want saved
      with a space.
- [ ] Do not open `demo/.env`, do not run `env`, `printenv` or `echo $OTARI_ADMIN_KEY`.
- [ ] Do not run `docker compose logs otari` on camera: Otari prints a bootstrap key
      there on first start.
- [ ] Dashboard: sign in **before** recording. Safe pages: Overview (Usage, Requests),
      the request detail panel, API keys, Routing. Do not open **Hosted providers** (it
      shows the last four characters of provider keys).

## Stack

- [ ] Docker running. Node 20 or newer (`node --version`).
- [ ] `firedrill` installed from the repo: `npm ci && npm install -g .` in `fire-drill/`.
      `firedrill --help` prints the usage.
- [ ] `OPENROUTER_API_KEY` exported (all three legs are real models through OpenRouter).
- [ ] One rehearsal run: `firedrill demo-chat --samples demo/samples.jsonl`. Leg 2 must
      show `4/5 80%  tool 1`. If it passes, see "If something differs on the day" in
      `PITCH.md`.

## Before each take

```bash
demo/reset.sh
```

```bash
export OTARI_BASE_URL=http://localhost:8000
```

```bash
export OTARI_ADMIN_KEY="$(grep ^OTARI_MASTER_KEY= demo/.env | cut -d= -f2-)"
```

```bash
clear
```

- [ ] `reset.sh` ends with "Ready." and the policy line names gpt-4o-mini, gemma-3-12b-it
      and mistral-small-3.2-24b-instruct.
- [ ] Browser: dashboard reloaded (reset empties the database, so sign in again with the
      master key if asked), on **API keys** for the pitch or **Overview → Requests** for
      the walkthrough. The Requests tab should be empty before the take.
- [ ] Terminal in `fire-drill/`, prompt empty.

## Not built

- VHS tapes (`video/*.tape`) were optional and are not included: VHS was not available
  where this was built, so a tape could not be verified.
