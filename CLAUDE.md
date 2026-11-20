# Working on this repository

- **Never put Claude chat session links** (claude.ai/code/session_… or any other Claude
  conversation URL) in commit messages, pull requests, issues, comments, code or docs — anywhere
  on GitHub.
- Keep `docs/plan.md` current: tick items as they land and record decisions there.
- `pnpm check` (format, lint, typecheck, tests) must pass; `scripts/ops/stack-smoke.sh` verifies
  the full stack end to end.
- Metadata-only logging: never log secrets, prompts, responses or file contents.
