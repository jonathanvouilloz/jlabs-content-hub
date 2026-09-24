# GMB-009 Employee Mentions Implementation Plan

> **For Hermes:** implement incrementally with tests before each production slice; do not commit or deploy without explicit approval.

**Goal:** Move employee-mention extraction into the durable daily job graph, enabled only by an explicit, versioned per-project projection capability, with replayable source-derived monthly totals and privacy-safe findings for unknown names.

**Architecture:** `project_projections.payload` becomes the authority for `gmb.employeeMentions` (disabled-by-default capability plus immutable roster version). A daily detector consumes source reviews after `collect:gmb_reviews`, calls an awaitable abortable LLM core, persists only canonical roster matches to `gmb_reviews.mentioned_employees`, derives read totals with SQL `GROUP BY`, and writes idempotent unknown-name findings without review comment or author data in finding/event evidence.

**Tech Stack:** SvelteKit, TypeScript, Drizzle/Postgres, Vitest, OpenAI SDK.

---

### Task 1: Model and validate the projection capability

**Files:**
- Modify: `src/lib/server/reviews/employee-mentions-state.ts`
- Test: `src/lib/server/reviews/employee-mentions-state.test.ts`
- Modify: projection reader adjacent to `src/lib/server/db/schema.ts`

1. Add a narrow parser for `gmb.employeeMentions` with `enabled: false` as the safe fallback.
2. Validate roster entries (stable id, display name, aliases, scoped locations and operational flags) and preserve its version.
3. Prove invalid/missing payloads cannot activate the capability; prove the Barber Concept roster matches aliases accent-insensitively.

### Task 2: Extract a bounded, awaitable and abortable mention-only LLM core

**Files:**
- Create: `src/lib/server/ai/employee-mentions.ts`
- Test: `src/lib/server/ai/employee-mentions.test.ts`
- Modify: legacy `src/lib/server/reviews/mentions-runner.ts` only to reuse the core where compatible

1. Write a failing test for a structured mention response, deterministic bounds, and abort propagation.
2. Implement an injected LLM adapter with a mention-only prompt; no reply generation and no `waitUntil`.
3. Keep retries bounded and signal-aware; map outputs only through the versioned roster matcher.

### Task 3: Persist source annotations and derive totals

**Files:**
- Modify: `src/lib/server/reviews/mentions.ts`
- Create: `src/lib/server/reviews/employee-mentions-read.ts`
- Test: matching state/read model tests

1. Remove mutable increment/decrement accounting from the durable path; source review annotations are the only write.
2. Implement a SQL `GROUP BY` reader over `gmb_reviews.mentioned_employees`, grouped by source review month and canonical employee name.
3. Prove replay/change of roster is reflected by reprocessing source rows, not compensating mutable counters.

### Task 4: Add `detect:employee_mentions` to the daily graph

**Files:**
- Create: `src/lib/server/detectors/employee-mentions.ts`
- Test: `src/lib/server/detectors/employee-mentions.test.ts`
- Modify: `src/lib/server/job-runner.ts`, `src/lib/server/schedule-state.ts`, `src/lib/server/job-limits.ts` and their tests

1. Write a failing detector test: disabled projects do no work; enabled projects select bounded eligible source reviews after collection.
2. Implement the detector with job `AbortSignal`; each call is awaited before job completion, so retry/lease behavior stays truthful.
3. Register `detect:employee_mentions` in the daily catalogue with an **obligatory** edge from `collect:gmb_reviews`; provider capacity reflects its LLM dependency.

### Task 5: Persist unknown-name findings safely and idempotently

**Files:**
- Modify: `src/lib/server/finding-state.ts` (only if vocabulary needs extending)
- Modify: `src/lib/server/detectors/employee-mentions.ts`
- Test: detector tests and finding vocabulary tests

1. For a detected non-attributable token, upsert `unknown_employee_mention` by project + review + normalized name.
2. Include only non-PII operational evidence (detector/roster version, location id, normalized token/hash as necessary); never include author name or comment in findings or `finding_events`.
3. Prove reruns create one finding/event and validation rejects any evidence shape containing review text or author data.

### Task 6: Projection migration, documentation and verification

**Files:**
- Create: additive manual migration / projection seed script only if runtime schema requires it
- Modify: `docs/BACKLOG.md`, `docs/DECISIONS.md`, `docs/features/gmb-009-employee-mentions.md`

1. Add the explicit current projection capability for Barber Concept only; all other projects remain disabled.
2. Document replayability, roster version ownership, unknown-name handling, no-PII invariant, and that no external reply is sent.
3. Run targeted Vitest files, `npm test`, `npm run check`, then inspect `git diff --check` and `git status --short`.

**Risks and invariants:** No production database mutation from local scripts (local `.env` targets production). No `waitUntil` in the durable detector path. Findings/events are append-only, therefore must contain no review comment or author name. Do not create/update `employee_mentions` mutable rows; future UI/report consumers must use the source-derived read model.
