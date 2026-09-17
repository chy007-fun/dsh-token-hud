# dsh-token-hud

[![npm](https://img.shields.io/npm/v/dsh-token-hud?label=npm)](https://www.npmjs.com/package/dsh-token-hud)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6)](https://github.com/deepseek-ai/deepseek-harness)

English | [中文](README.md)

**Global real-time Token HUD for DeepSeek Harness Web**: a draggable, collapsible floating window that shows live generation throughput (tok/s), cumulative output tokens, and per-session status across **all** DSH sessions.

```text
● Token HUD
  31.4 tok/s              <- sum of all streaming sessions
  output 12.3K tok · running 2
  ● sess-a  deepseek-v4-pro   28.1    <- one row per active session
  ● sess-b  (retrying)
  ─────────────────────
  Model usage (resets on restart)
  deepseek-v4-pro  ↑12.3K  ⚡58.2
  glm-5.3          ↑4.5K   ⚡31.0
```

Status dot: green = streaming (pulsing) · yellow = awaiting model · orange = retrying (pulsing) · blue = tool call · gray = idle/offline.
Model aggregation: `↑` is the in-process cumulative output for that model; `⚡` is the historical peak of the rolling-window tps while the model was active. Both are host-side in-memory only and reset automatically on restart.

## Why

The built-in stats line only shows tok/s **after a step completes and only when the provider reports usage**. Free-gateway models often report no usage or stall mid-stream — you cannot tell "generating slowly" from "dead". This plugin estimates tokens **directly from stream chunks** (CJK ≈ 1 tok/char, other ≈ 4 chars/tok), updates while text is arriving, and self-corrects to exact values when provider usage lands. Pairs well with `retryPolicy: always` (`@deepseek-ai/dsh-llm-retry`): the dot pulses orange while retrying and turns green the moment tokens flow again.

## Install

```sh
dsh plugin --profile web add dsh-token-hud
```

Restart `dsh web`; the HUD appears in the bottom-right corner. Position and collapsed state persist via localStorage.

Local development install:

```sh
dsh plugin --profile web add link:<space-free-path>/dsh-token-hud
```

> On Windows, paths with spaces get split by dsh argument parsing; create a junction to get a space-free entry point:
> `New-Item -ItemType Junction -Path C:\Users\Public\dsh-token-hud -Target <real-dir>`

## Configuration (cordis.patch.yml, optional)

```yaml
- insert:
    - id: token-hud
      name: dsh-token-hud
      inject: [webServer]
      config:
        apiPath: /token-hud/v1     # read-only HTTP endpoint prefix
        charsPerToken: 4           # non-CJK characters per token
        cjkTokensPerChar: 1        # tokens per CJK character
        windowMs: 5000             # rolling TPS window
        idleTtlMs: 180000          # idle session eviction
```

## How it works

- **Host half**: live throughput adapts across streaming channels — newer hosts (0.1.5-rc.2+, format v2) broadcast per-chunk `agent/assistant-stream` frames (subagents included), older hosts deliver `assistant/chunk` session events; the channels are mutually exclusive and the old one disables itself once frames are seen (double-count guard). Character heuristics (CJK ≈ 1 tok/char, other ≈ 4 chars/tok) feed a rolling TPS window; estimates self-correct when `assistant/message` carries usage. The host also aggregates per-model cumulative output tokens and the historical peak of the rolling tps (model attribution starts early via `request/header` when available and is completed by `assistant/message`); both are purely in-memory and reset automatically on restart. A state machine tracks running/streaming/tool/retrying/idle. Exposes a read-only endpoint `GET /token-hud/v1/stats` via `webServer`. No persistence, no session-log writes, zero prompt effect.
- **Client half**: registers into `shell.overlay` (the official frame-wide overlay slot), polls once per second, pauses when the page is hidden, and degrades to a gray "offline" pill after 5 consecutive failures; `stats.models` renders per-model `↑` cumulative output and `⚡` peak tps rows.

## Known limitations

- Throughput is an **estimate** (~10% error) until provider usage arrives; cache read/write tokens are excluded from speed.
- Cumulative counters reset on host restart (no persistence).
- The HUD shows the **whole-DSH aggregate**; the currently open conversation does not change the display.

## Test

```sh
node test.mjs          # host logic (estimation / correction / state machine / HTTP)
node test.client.mjs   # client jsdom smoke (render / collapse / persistence / offline)
```

## License

MIT
