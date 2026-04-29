# Agent Instructions

This project keeps its detailed Claude Code instructions in `CLAUDE.md`.
All coding agents working in this repository should follow those same
Karpathy-inspired guidelines:

- Think before coding: state assumptions, surface ambiguity, and ask when the
  request is genuinely unclear.
- Keep changes simple: implement the minimum useful change and avoid speculative
  abstractions.
- Make surgical edits: touch only files needed for the request, match local
  style, and avoid unrelated refactors.
- Work toward verifiable goals: define success criteria for non-trivial tasks
  and run the relevant checks before finishing.

The same project restrictions in `CLAUDE.md` apply here:

- Do not run `git push` without explicit user permission.
- Do not deploy to the router or copy files to it without explicit user
  permission.
- Do not commit secrets, generated client profiles, real endpoints, private IP
  details, QR payloads, UUIDs, keys, or local-only aliases.

For project-specific architecture, routing, deploy, and report workflow details,
read `CLAUDE.md`, `README-ru.md`, and the relevant module documentation before
making changes.
