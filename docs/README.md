# Engineering documentation

Start with [AGENTS.md](../AGENTS.md) for repository working rules. Use this index
to find the details needed for a task.

| Document | Owns |
| --- | --- |
| [Product README](../README.md) | Features, basic setup and contributor entry points |
| [Architecture](architecture.md) | Process boundaries, download flow, state, storage and code navigation |
| [Binary guide](../binaries/README.md) | Helper sources, per-platform names, fetch commands and local layout |
| [Release guide](releasing.md) | CI, native validation, app/engine updates, release notes and publication boundaries |
| [Analytics](analytics.md) | Event interpretation, older-client differences and dashboard caveats |
| [Privacy](../PRIVACY.md) | User-facing telemetry disclosure |
| [FFmpeg build information](../third-party/ffmpeg/build-info.md) | Platform provenance and corresponding-source records |

## Keeping context accurate

Source, tests, package manifests and workflows establish implemented behavior.
Update the corresponding guide when changing that behavior. Keep volatile version
numbers, asset checksums and exhaustive event lists in their existing owners
rather than copying them across these pages.

The files under `superpowers/specs/` and `superpowers/plans/` are historical design
records. Check their assumptions against current code before applying them.
Keep task status and test evidence in the PR or a task-specific plan; do not turn
AGENTS.md into a running chat log.

Codex discovers the uppercase root `AGENTS.md`. Other tools may need their project
instructions configured to read it. Keep one shared source of project rules
instead of maintaining independent, conflicting manuals for each agent.

## Why this layout

Reviewed November 2, 2026. These references informed the layout; the choice to use
a short instruction file plus task-specific guides is our engineering judgment:

- [OpenAI: AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
  documents root and nested instruction scopes.
- [OpenAI: harness engineering](https://openai.com/index/harness-engineering/)
  describes a small entry-point map linked to maintained repository knowledge.
- [Anthropic: context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)
  discusses selecting relevant context as work proceeds.
- Research results are mixed: [Lulla et al.](https://arxiv.org/abs/2601.20404)
  observed efficiency improvements in their sample, while
  [Gloaguen et al., revised September 2026](https://arxiv.org/abs/2602.11988)
  found added cost without general success improvements. These studies are not a
  guarantee about Cliply. Keep instructions specific and validate actual changes.
