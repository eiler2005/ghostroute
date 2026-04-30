@AGENTS.md

# Claude Code

Shared project instructions live in `AGENTS.md`. Claude Code should load this
file as its project entrypoint, import the shared guidance above, and avoid
duplicating long-lived rules here.

Claude-specific working notes:
- Keep plans brief and tied to verifiable checks.
- For trivial tasks, use judgment instead of expanding every rule into a long
  process.
- If Claude repeatedly makes a project-specific mistake, add the durable rule to
  `AGENTS.md` so Codex and other agents inherit it too.
- Keep this file short; duplicated guidance will drift.
