# atto1 — Architectural Constraints

This file is the permanent grounding document for Claude Code in this repository.
These rules are non-negotiable and must never be violated without explicit Director approval.

## Package Manager

- **pnpm only.** Never run `npm install` or `yarn`.
- All dependency changes must use `pnpm add` / `pnpm remove`.

## Stack Constraints

- Stack: **Vite 8 + React 19 + TypeScript 6 + Tailwind CSS v4 + a Cloudflare Worker over D1, behind Cloudflare Access**.
  No additions without Director approval.
- Tailwind v4 is CSS-first — config lives in `src/index.css` via `@import "tailwindcss"` and `@theme`.
  Never create `tailwind.config.*` or `postcss.config.*`.
- All new source files must be `.ts` or `.tsx`. Never create `.js` source files.

## Data Layer

- `src/lib/api.ts` is the only browser data-access entry point; it calls the Worker (`worker/`), which checks the Cloudflare Access token and scopes every D1 query by `user_id` (ADR-005).
- The D1 schema lives in `migrations/` (ADR-003, ADR-005) and is mirrored by `src/lib/data-model/types.ts` and `validation.ts` — change them together. New tables still need Director approval.
- Never commit `.env.local` or real credentials.

## TypeScript

- Strict mode. Avoid `any`; use `unknown` and narrow explicitly.
- Establish types or Zod schemas before writing runtime logic for external data.

## Director-Agent Workflow

- All non-trivial work begins with a GitHub issue — the issue is the source of truth, not a `.claude/tasks/` file. See `docs/agents/issue-tracker.md`.
- Claude writes the specification into the issue body under "## Specification", then appends its implementation plan under "## AI Implementation Plan" (files to create/modify/delete, step-by-step execution, risks) before writing any code.
- Claude summarises the plan in chat so the Director can review without opening the issue.
- Code execution is blocked until the Director provides explicit approval in chat.
- Claude executes, comments on the issue with the verification checklist and results, and closes it once the Director confirms the work is merged.
- Chat is the interface — the GitHub issue is the record.
- **Migration note (2026-07-17):** this repo's Director-Agent record moved from `.claude/tasks/task-NNN-*.md` files to GitHub issues, adopting Matt Pocock's skills convention in full rather than as a scoped exception. Task files created before this date remain as a historical archive; no new ones are created.
