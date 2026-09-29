# Channel Test UI Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the local channel-test dialog with MAakber's capability-matrix workflow while preserving the local backend contract and channel-specific extensions.

**Architecture:** Keep `testChannelDetailed`/`runChannelProbe` and the shared probe queue as the data layer. Split the dialog UI into capability controls, a model matrix, and result/details presentation; the dialog owns selection, filters, endpoint overrides, deletion, and list-cache updates. Custom one-run text moves into a collapsible advanced section and remains excluded from tool probes.

**Tech Stack:** React, TypeScript, TanStack Table, React Hook Form/i18n conventions already present in `web/`, Vitest, Testing Library, Tailwind CSS.

**Spec:** Confirmed in the conversation on 2026-09-08; comparison against `remotes/maakber/main` at `c0ee46798`.

## Global Constraints

- Do not merge MAakber's unrelated commits or replace the existing backend.
- Preserve the local `runChannelProbe` request contract and five-request shared queue.
- Tool probes must continue using the built-in probe instruction rather than the custom message.
- Keep existing response-preview redaction and channel-list response-time cache updates.
- Do not stage or commit unrelated user files: `docker-compose.yml`, `.tmp-go-cache/`, `backups/`, or `web/pnpm-lock.yaml`.
- Use Chinese translations for all newly visible controls through the existing i18n key system.

### Task 1: Add failing tests for the aligned controls and matrix

**Files:**
- Modify: `web/src/features/channels/__tests__/channel-test-fixture.tsx` only if the existing fixture needs the new component tree.
- Create or modify: `web/src/features/channels/components/dialogs/__tests__/channel-test-dialog-layout.test.tsx`
- Create or modify: `web/src/features/channels/components/dialogs/__tests__/channel-test-interactions.test.tsx`
- Modify: `web/src/features/channels/components/dialogs/__tests__/channel-test-capabilities.test.tsx` if the old cell contract is removed.

**Interfaces:**
- Tests consume the public `ChannelTestDialog` behavior through the existing fixture.
- Tests assert the capability selector, advanced message field, model matrix, per-model endpoint override, filters, retest action, and selection behavior.

- [ ] **Step 1: Write tests that expect a collapsible advanced message override and four capability checkboxes.**
- [ ] **Step 2: Write tests that expect the matrix to render one status cell per capability and expose start, selected, retry, and stop actions.**
- [ ] **Step 3: Write tests that expect a model endpoint override to mark prior results stale without issuing a request.**
- [ ] **Step 4: Run the focused channel-test suite and confirm the new assertions fail because the current dialog still uses the legacy layout.**

### Task 2: Implement reusable capability controls

**Files:**
- Create: `web/src/features/channels/components/dialogs/channel-test-controls.tsx`
- Modify: `web/src/features/channels/lib/channel-test.ts` only where endpoint/probe labels or types need to match the control contract.

**Interfaces:**
- Produces `ChannelTestControls` with selected probe IDs, default endpoint, and one-run message callbacks.
- Produces `ChannelProbeEndpointSelect` for the global and per-model endpoint selectors.

- [ ] **Step 1: Add the minimal controls implementation that renders four selectable capabilities and a default endpoint selector.**
- [ ] **Step 2: Put the test-message textarea and tool/image notes inside the `Advanced settings` collapsible panel.**
- [ ] **Step 3: Preserve disabled behavior while a probe run is active and keep the mobile capability section collapsible.**
- [ ] **Step 4: Run the focused layout tests and confirm the controls assertions pass.**

### Task 3: Implement matrix result cells and details presentation

**Files:**
- Create: `web/src/features/channels/components/dialogs/channel-test-matrix.tsx`
- Create: `web/src/features/channels/components/dialogs/channel-test-result.tsx`
- Reuse: `web/src/features/channels/components/dialogs/channel-test-preview.tsx`

**Interfaces:**
- `ChannelTestMatrix` accepts models, probe results, row selection, per-model endpoint overrides, and run/detail callbacks.
- `ChannelProbeCell` renders status, duration, stale state, and click behavior without duplicating request logic.
- `ChannelProbeDetails` continues to expose diagnostics, errors, retry, response preview, and raw response.

- [ ] **Step 1: Add a desktop table with model/endpoint plus one column per probe and a mobile card fallback.**
- [ ] **Step 2: Render idle, queued, running, passed, failed, degraded, skipped, and cancelled states with localized labels.**
- [ ] **Step 3: Keep endpoint applicability and stale-result handling in the cell layer.**
- [ ] **Step 4: Run matrix/detail tests and confirm they pass without changing the backend.**

### Task 4: Refactor the dialog workflow around selected probes and matrix jobs

**Files:**
- Modify: `web/src/features/channels/components/dialogs/channel-test-dialog.tsx`
- Modify: `web/src/features/channels/hooks/use-channel-probes.ts` only for interface compatibility with the dialog; preserve queue semantics.
- Modify: `web/src/features/channels/lib/channel-test.ts` only for shared job/configuration helpers.

**Interfaces:**
- Dialog state tracks selected probes, global endpoint, per-model endpoint overrides, custom message, search/filter, and row selection.
- `useChannelProbes` remains the only executor and continues to call `runChannelProbe`.

- [ ] **Step 1: Replace the legacy endpoint/stream/message block and status/result/capability table with `ChannelTestControls` and `ChannelTestMatrix`.**
- [ ] **Step 2: Build jobs for selected models or filtered models and only selected/applicable probes.**
- [ ] **Step 3: Add result filters, selected-model copy/clear actions, progress summary, estimated request count, start/retest/stop actions, and failed-model deletion.**
- [ ] **Step 4: Keep response-time cache patching and dialog close behavior intact.**
- [ ] **Step 5: Run the focused interaction suite and fix implementation defects, not tests.**

### Task 5: Synchronize translations and static keys

**Files:**
- Modify: `web/src/i18n/locales/zh.json`
- Modify: `web/src/i18n/static-keys.ts`
- Modify: other locale files only if the repository's key-validation workflow requires complete fallback entries.

**Interfaces:**
- All new controls use existing `t(...)` calls with Chinese entries for the configured Chinese locale.

- [ ] **Step 1: Add Chinese entries for capability names, statuses, advanced settings, endpoint labels, filters, progress, and matrix actions.**
- [ ] **Step 2: Run the i18n/static-key validation and add only the required fallback keys.**

### Task 6: Verify the aligned dialog

**Files:**
- No production files beyond the tasks above.

- [ ] **Step 1: Run the focused channel-test Vitest config.**
- [ ] **Step 2: Run the web typecheck/lint commands used by the repository.**
- [ ] **Step 3: Run the relevant Go channel-test tests to verify the backend contract is unchanged.**
- [ ] **Step 4: Inspect the final diff and confirm unrelated user files remain untouched.**

