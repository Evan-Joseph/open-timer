# Timeline and Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver quiet-period-aware reminders, semantic desktop timeline scales, a seven-day swimlane review, and continuous view transitions.

**Architecture:** Shared pure functions own wall-clock quiet intervals and timeline bounds. `Timeline.tsx` consumes those functions for the single-day and seven-day renderers; `ClockFace.tsx` gates reminder side effects from the same quiet policy. `motion/react` remains the sole animation runtime.

**Tech Stack:** React 18, TypeScript, motion/react, Hono/D1 API, Vitest, Playwright.

---

### Task 1: Pure Time Policies

**Files:**
- Create: `shared/src/timeline-policy.ts`
- Test: `shared/src/timeline-policy.test.ts`
- Modify: `shared/src/index.ts`

- [ ] Write failing tests for 08:00–22:30 bounds, effective bounds with 30-minute padding, and quiet intervals including cross-midnight.
- [ ] Run `npm exec -w shared vitest run src/timeline-policy.test.ts` and confirm failure.
- [ ] Implement pure `timelineRange()` and `isQuietPeriod()` functions with Asia/Shanghai minute-of-day inputs.
- [ ] Re-run the focused shared test and commit the pure policy.

### Task 2: Reminder Quiet Gate

**Files:**
- Modify: `web/src/components/ClockFace.tsx`
- Test: `e2e/flow.spec.ts`

- [ ] Add failing virtual-clock E2E coverage proving a paused session does not show a dialog or emit an escalation during quiet hours.
- [ ] Implement a quiet gate for the away level, sound effects and recall overlay; reset one-shot chimes when quiet begins.
- [ ] Run the focused E2E and commit.

### Task 3: Single-Day Semantic Scales

**Files:**
- Modify: `web/src/components/Timeline.tsx`
- Modify: `web/src/styles.css`
- Test: `e2e/flow.spec.ts`

- [ ] Add failing E2E checks for default, 全天 and 有效全天 controls and remove the zoom controls.
- [ ] Replace pixel zoom state with `default | full-day | effective-day`; derive tick range and segment positions from shared bounds.
- [ ] Preserve user browsing; only initial load, new session and “现在” target the 60% Flag position.
- [ ] Run focused E2E, take desktop screenshots, and commit.

### Task 4: Seven-Day Swimlane View

**Files:**
- Modify: `web/src/components/Timeline.tsx`
- Modify: `web/src/styles.css`
- Test: `e2e/flow.spec.ts`

- [ ] Add failing E2E coverage showing seven swimlanes, no single-day track, non-navigating day labels, and automatic bottom reveal after loading.
- [ ] Fetch sessions for seven dates, render fixed 全天 swimlanes, and retain summary metrics from daily summaries.
- [ ] Use a guarded `scrollIntoView({ behavior: 'smooth', block: 'end' })` after the report becomes stable.
- [ ] Run focused E2E and commit.

### Task 5: Motion Audit and Integration

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/ClockFace.tsx`
- Modify: `web/src/components/Timeline.tsx`
- Modify: `web/src/styles.css`
- Test: `e2e/style-review.spec.ts`, `e2e/flow.spec.ts`

- [ ] Add E2E checks for view exit/enter state and reduced-motion operation.
- [ ] Add `AnimatePresence`/layout transitions at state and view ownership boundaries; consolidate CSS easing and remove duplicate hard-cut animations.
- [ ] Run full tests, typecheck, production build, desktop screenshots, then commit and deploy.
