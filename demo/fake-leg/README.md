# fake-leg

A stand-in for a cheap model that breaks your JSON. It speaks the OpenAI chat
completions API and always answers in prose, so Fire Drill's schema and tool
checks fail on it every time. That keeps the demo's failing leg the same on
every take.

It is registered in Otari as a named provider instance (`drillfake`, see
`demo/otari-config.yml`) and called as `drillfake:prose-only`. It is **not** a
real model: the demo says so on screen. The passing legs are real models.

Otari's provider endpoints cannot be used here: a routing policy does not
resolve them (`docs/provider-endpoints.md` in Otari).
