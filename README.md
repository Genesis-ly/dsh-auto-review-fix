# dsh-auto-review-fix

**English** | [中文](README.zh-CN.md)

Fixes the entry side of the official Auto review integration
(`@deepseek-ai/dsh-experimental-auto-review`): when the reviewer call fails, `tools/pre-execute`
throws and the whole tool channel is blocked — even `echo hi` cannot run.

No vendor file is modified, so the fix survives plugin and app updates.

See [docs/bugs/02-auto-review-fails-closed.md](docs/bugs/02-auto-review-fails-closed.md) for the
full write-up.

## Three real failure sources

86 blocked tool results from 45 sessions fall into three classes:

| # | Error | Evidence | Cause |
| --- | --- | --- | --- |
| A | `auto-review: reviewer must emit zero or more reasoning blocks followed by exactly one text block` | `provider=custom-route model=DeepSeek-V4.1-Flash tools=101 hasTool=true` | the reviewer call reuses the session provider; that third-party route does not follow the review protocol, so shape validation always fails (`Unexpected token 'I'` has the same origin) |
| B | `auto-review: reviewer ended with error STREAM_CLOSED: …` | `provider=deepseek-account model=deepseek-flash` | transient upstream stream close; the integration never retries |
| C | `auto-review: the pending native tool schema is missing or ambiguous` | `provider=deepseek-account tools=142 hasTool=false` | `session.requestHeader()` can point at a non-chat request (title generation / compaction); the tool schema is absent |

## Fix

Two service wrappers; nothing under `app.asar` is patched.

1. **Reviewer route: session first, fallback only on failure** (wraps `ctx.llm.stream`).
   Only calls whose system prompt contains `You are the final authorization reviewer` are touched;
   everything else passes through. The first attempt keeps the call parameters (the session's own
   provider/model). Every attempt is pre-checked against the integration's acceptance rules — a
   terminating `finish`, `stop` reason, zero or more reasoning blocks followed by exactly one text
   block that parses as the risk/decision protocol. Only if that fails is the call retried once with
   a fixed fallback route (default `deepseek-account` / `deepseek-flash`).
2. **Gate fallback** (`prepend` `tools/pre-execute`). It runs before the integration, so it can
   catch its exceptions. Only `auto-review:`-prefixed errors are converted — by default to `ask`,
   i.e. the normal approval prompt, not a failed tool call. Exceptions from other plugins are
   re-thrown untouched.

Each route fallback and gate fallback appends one line to `~/.dsh/dsh-auto-review-fix/audit.jsonl`.

## Configuration

```yaml
- id: dsh-auto-review-fix
  config:
    enabled: true
    route: session                    # session (default) | fixed
    # provider: deepseek-account      # only for route: fixed
    # model: deepseek-flash
    fallbackProvider: deepseek-account
    fallbackModel: deepseek-flash
    retries: 0                        # extra attempts on the primary route
    fallback: ask                     # ask | allow | deny
    auditPath: '~/.dsh/dsh-auto-review-fix/audit.jsonl'
```

`fallback: allow` bypasses review and should only be used on a machine you fully control.
`fallback: deny` keeps fail-closed behaviour but with a clearer message.

The legacy `inheritRoute` key is still accepted (`true` → `route: session`, `false` → `route: fixed`).

## Install

```powershell
# Quit DSH completely first.
pwsh -NoProfile -File .\scripts\install.ps1
```

Restart DSH. On load the Host log shows:

```
dsh-auto-review-fix: review route the session route, fallback deepseek-account/deepseek-flash, retries 0, gate fallback ask, stream hook on
```

## Tests

```powershell
npm test        # 27 cases
```

Covers route pre-validation, fallback, gate fallback, and pass-through of unrelated LLM calls.

## Compatibility

DSH 0.2.2-rc.5, Windows 10/11, Node >= 20.

## License

MIT — see [LICENSE](LICENSE). Security policy: [SECURITY.md](SECURITY.md).
