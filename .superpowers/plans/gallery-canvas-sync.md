# Shared Gallery and Local-first Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Drawing and NAI persistent multi-canvas editors with a shared image gallery, browser-first saves and quota-aware private cloud copies.

**Architecture:** IndexedDB stores asset Blobs once and documents referring to asset IDs. The existing single-instance gallery store publishes complete cloud revisions under its mutex and uses minimal removal records to distinguish explicit deletion from expiry. Existing gallery UI and editors consume one local repository and sync coordinator; no additional service or queue infrastructure.

**Tech Stack:** Go 1.25.1 baseline, Gin/GORM, SQLite/MySQL/PostgreSQL, React/TypeScript, Zustand, IndexedDB, TanStack Query/Router, Vitest.

**Spec:** `.superpowers/specs/shared-gallery-canvases-design.md` (approved, binding).

**Execution update (2026-09-11):** The user requested faster delivery and no repeated broad testing. Reuse completed real database/router/full backend evidence for unchanged code; perform focused checks for new changes and a production build. Final release CI remains mandatory. Once an implementation commit is frozen, its read-only review may overlap the next UI implementation; keep one source-writing implementer at a time and resolve load-bearing findings before publishing.

## Global Constraints

- Work directly on `/Volumes/Samsung980PRO/CODE/new-api`, branch `main`; no new worktree or branch, per explicit user instruction.
- Preserve unrelated `docker-compose.yml`, `.build/`, `.tmp-go-cache/`, `backups/`, `docs/superpowers/plans/`, `node_modules/`, `web/pnpm-lock.yaml`. Never stage with `git add .`.
- Do not add files under `docs/`, install dependencies, clean caches, delete user data, or run paid generation requests.
- 单个 new-api 实例，复用现有数据库、私有文件目录和后台清理任务；不新增独立服务、消息队列、分布式协调或对象存储依赖。
- No public gallery, cross-user browsing (including root), content-audit expansion, cross-canvas reference editing or new NAI reference-generation feature.
- Local write debounce 2 seconds; dirty-only timed cloud synchronization at least 5 minutes apart; leaving/explicit save can bypass that timer but never a known-full pause.
- Logout gives eligible cloud saves at most 5 seconds; known-full uploads never start or delay logout. Session changes abort requests and release object URLs. Saved documents contain no credentials.
- Known-full state survives navigation/reload. Only lightweight quota checks, at least 5 minutes apart while pending, except a successful deletion can check immediately. No unexpired eviction.
- First entry into full state notifies once; persistent Chinese status: `已保存到本地，云端空间不足，暂未上传。` Local-save claims require transaction success, synced claims require cloud success.
- One canonical original per shared resource; thumbs count bytes not image count; references count original count and bytes, masks count bytes only. Documents/metadata count bytes; browser caches do not count server quota.
- Delete image in either view removes corresponding asset/node in both, preserving other images. Delete canvas removes its assets from both. Remove-reference only detaches; do not delete the user's source file.
- Explicit deletion cancels pending/late writes and obsolete undo snapshots; reconnecting devices honor removal markers. Expiry removes only cloud copies, preserving local drafts as local-only without unchanged automatic reupload.
- Actual content changes renew retention; viewport-only updates, opening and idempotent retries do not. Existing setting values and expiry dates remain until real new saves.
- All private reads/writes enforce owner on the server; streamed bytes obey actual remaining quota/disk and safe-download rules; failed saves preserve the last complete cloud revision.
- UI text goes through existing i18n and renders Chinese. Reuse ConfirmDialog, Dialog, EmptyState, LoadingState, ErrorState and GalleryPreview. Do not deploy prototype HTML.
- Before release verify actual SQLite/MySQL/PostgreSQL fresh and released-schema upgrade migrations twice, affected tests, typecheck, changed-file lint and production build. Report exact engine versions.
- SDD workers never spawn agents. Controller alone dispatches reviews. Workers commit scoped files, never push/tag/deploy; controller performs the user-authorized release after final checks.
- Run tools with external temp/cache: `TMPDIR=$PWD/.build/gallery-canvas-sync-gnaB30`, `GOTMPDIR` same, `GOMODCACHE=$PWD/.build/gomodcache`, `GOCACHE=$PWD/.tmp-go-cache`. Bun unavailable; use installed Node binaries in `web/node_modules/`, no lockfile edits.

## File and contract map

- `model/gallery-canvas.go`: persisted canvas metadata, revision/removal records and document decoding; `model/gallery.go`: migration and shared usage counts.
- `service/gallery-canvas-document.go`: allowlisted document validation and content fingerprint; `service/gallery-canvas.go`: streamed atomic save, read/list, deletion/reconciliation. `service/gallery-storage.go`: reuse writers/download validation; `service/gallery.go`: integrate cleanup/usage/listing/legacy delete.
- `controller/gallery.go`, `router/api-router.go`: existing private gallery group; new canvas handlers may live in `controller/gallery-canvas.go` to keep functions focused.
- `service/gallery_test.go`: shared backend regression fixture and real-database matrix, not a new test file per layer.
- `web/src/features/gallery/types.ts`, `api.ts`: shared wire contract and same session-scoped request wrapper.
- `web/src/features/gallery/lib/canvas-document.ts`: lossless editor document/asset-reference codec and explicit node/resource relations.
- `web/src/features/gallery/lib/canvas-repository.ts`: IndexedDB canvas/asset/user-state repository and old-draft migration.
- `web/src/features/gallery/lib/canvas-sync.ts`: session-bound synchronization and quota pause state machine.
- `web/src/features/gallery/hooks/use-canvas-projects.ts`: reactive editor lifecycle bridge; existing persistence hooks delegate here.
- `web/src/features/gallery/components/`: image/canvas business composition over existing shared primitives; gallery index and editor headers show save state.

### Shared wire shape

```ts
type CanvasKind = 'drawing' | 'nai'
type CanvasAssetRole = 'generated' | 'reference' | 'mask'
type CanvasAssetRef = { id: string; name: string; width: number; height: number; mimeType: string }
type CanvasRemoteAsset = { id: string; role: CanvasAssetRole; node_id: string; sha256: string; bytes: number; width: number; height: number; mime_type: string; has_thumbnail: boolean }
type CanvasRecord = {
  id: string; kind: CanvasKind; name: string; revision: number;
  state: 'ready' | 'deleted' | 'expired'; updated_at: number; expires_at: number;
  document: Record<string, unknown> | null;
  removed_asset_ids: string[];
  assets: CanvasRemoteAsset[];
  asset_id_map: Record<string, string>;
}
type CanvasSummary = Omit<CanvasRecord, 'document' | 'assets' | 'asset_id_map' | 'removed_asset_ids'> & { cover_asset_ids: string[] }
type CanvasSaveMetadata = {
  id: string; kind: CanvasKind; name: string; base_revision: number;
  mutation_id: string; document: Record<string, unknown>;
  explicit_save?: boolean;
  assets: { id: string; role: CanvasAssetRole; node_id: string; bytes: number; sha256: string }[];
}
```

Document uses the existing editor version 1 shape (nodes/settings/viewport; Drawing also edges/referenceIds/mask), except every asset omits `src` and holds a stable UUID reference. Preserve asset descriptors, positions, prompts/settings and existing supported relations. No unknown properties or credentials survive normalization. Generated node/asset identifiers are linked at insertion, not inferred from names/time. Existing original IDs can be reused only after exact ownership + original checksum/explicit ID verification, not heuristic matching. Canonical asset IDs are UUIDs. Same ID repeated in a canvas has one binary, one usage entry.

Routes under existing authenticated `/api/gallery`:

```text
GET    /canvases?page=1&page_size=24&source=drawing&search=&sort=updated_desc
GET    /canvases/:id                 -> CanvasRecord (minimal state for expired/deleted)
POST   /canvases                     -> CanvasRecord, multipart metadata first, then file:<asset UUID> / thumbnail:<asset UUID> only for new assets
DELETE /canvases/:id?revision=N      -> deletion state, idempotent for owner
DELETE /canvases/:id/assets/:assetId?revision=N -> new CanvasRecord, explicit removal marker
GET    /usage?required_bytes=N&required_images=N -> existing usage plus available_bytes, available_images, can_save for this request
GET    /images?page=1&source=&search=&sort=created_desc -> legacy + generated linked resources, excludes reference/mask
```

All retain `success/data/message` envelope. Canvas list returns paginated CanvasSummary items: omit large documents, full resource manifests and prompts from the listing query, and include at most four cover resource IDs. Get/save responses include the authoritative asset manifest, so a generated image used as a reference is not confused with an imported reference. `asset_id_map` is empty unless exact-checksum legacy reuse canonicalizes a submitted ID to an existing owned original; the coordinator must apply only that identifier remap to the latest local record/editor without overwriting newer edits. Revision conflict or a snapshot containing an explicitly removed resource is HTTP 409, code `canvas_conflict`; a whole-canvas explicit deletion is HTTP 410, code `canvas_deleted`; invalid 400; owner mismatch 404. Expired canvas remains addressable as minimal state; reviving requires current base revision plus a new mutation and actual content edit or explicit_save intent from the coordinator. The optional explicit_save flag cannot bypass quotas/revisions. Removed asset IDs are never allowed back automatically. Cloud save is a snapshot, not implicitly a destructive delete: omissions of linked generated/reference originals are rejected until explicit DELETE. Obsolete masks after actual mask/reference edits can be retired only after successful atomic publication, with physical bytes counted until removal; failed hydration must never be interpreted as deletion.

### Task 1: Schema and validated canvas document contract

**Files:** Create `model/gallery-canvas.go`, `service/gallery-canvas-document.go`; modify `model/gallery.go`, `service/gallery_test.go`.

**Interfaces:** Produces `model.GalleryCanvas`, `model.GalleryRemoval`; `service.NormalizeGalleryCanvasDocument(kind string, document map[string]any) (*service.GalleryCanvasDocumentInfo, error)` with `Document map[string]any`, `Assets []service.GalleryCanvasAssetRef`, `ContentHash string`, `Bytes int64`. `GalleryCanvasAssetRef` has `ID, Name, MIMEType string`, `Width, Height int`. `GalleryImage` adds `CanvasID, NodeID, Role, SHA256` strings. GalleryCanvas persists wire fields plus owner, mutation ID, JSON, content hash, StorageBytes; removal only owner/IDs/revision/reason/time. Existing `MigrateGallery` adds new schemas; existing `GalleryTotals` counts originals excluding mask, sums all physical images plus canvas metadata.

- [x] **Step 1: Add behavior tests first in existing service/gallery_test.go.** Retain legacy records/settings across a repeated migration; masks do not increment count; documents add bytes. Start document normalization with an empty valid Drawing document and viewport-only comparison:

```go
doc := map[string]any{"version": float64(1), "nodes": []any{}, "edges": []any{}, "referenceIds": []any{}, "mask": nil, "viewport": map[string]any{"x": float64(0), "y": float64(0), "zoom": float64(1)}, "settings": map[string]any{"model": "gpt-image-1", "size": "auto", "n": float64(1)}}
first, err := service.NormalizeGalleryCanvasDocument("drawing", doc)
require.NoError(t, err)
doc["viewport"] = map[string]any{"x": float64(20), "y": float64(10), "zoom": float64(2)}
second, err := service.NormalizeGalleryCanvasDocument("drawing", doc)
require.NoError(t, err)
assert.Equal(t, first.ContentHash, second.ContentHash)
```

Add literal fixtures for valid Drawing references/mask/edge and NAI settings; credential/unknown-key rejection or stripping, embedded `src` rejection, duplicate node IDs, dangling refs, mismatched mask, malformed numbers/version. Exercise real normalization, not source scans.

- [x] **Step 2: Run RED.** `go test ./service -run 'Gallery.*(Canvas|Migration|Totals)' -count=1` with external cache env. Record missing functionality/failing assertions, not unrelated build errors.
- [x] **Step 3: Implement additive schema and allowlist normalization.** Use common JSON wrappers, Go version baseline, GORM portable TEXT/varchar fields. Do not include credential fields in settings allowlists; read actual Drawing/NAI schemas and retain their supported settings. Hash deterministic normalized content excluding viewport/runtime-only fields:

```go
content := maps.Clone(normalizedDocument)
delete(content, "viewport")
raw, err := common.Marshal(content)
if err != nil { return nil, model.ErrGalleryInvalid }
sum := sha256.Sum256(raw)
info.ContentHash = hex.EncodeToString(sum[:])
```

Validate structural maxima from existing document schemas (500 nodes, 8000 edges, 16 references), finite geometry, safe enum/text fields. These are existing capability bounds, not extra per-image or per-save quotas. Parse descriptors only; never persist base64/src. Add settings migration defaults only on first record creation. For DocumentJSON and RemovedAssetIDsJSON use `gorm:"size:-1"` as a portable large-text storage-type hint (MySQL LONGTEXT, PostgreSQL/SQLite text), not a new save-size quota; verify actual database types and >64 KiB roundtrips in the matrix.
- [x] **Step 4: Run GREEN and existing gallery tests.** `go test ./service -run Gallery -count=1`; gofmt changed Go files; `git diff --check`. Controller runs actual engine matrix after full backend exists.
- [x] **Step 5: Commit scoped files.** `git add model/gallery.go model/gallery-canvas.go service/gallery-canvas-document.go service/gallery_test.go` then `git commit -m "feat(canvas): add shared canvas document schema"`. Report exact exported contract and RED/GREEN evidence.

### Task 2: Atomic cloud copies, quotas, private API and deletion lifecycle

**Files:** Create `service/gallery-canvas.go` (save/read/list orchestration), `service/gallery-canvas-storage.go` (streamed asset preparation), `service/gallery-canvas-lifecycle.go` (deletion/expiry), and focused `controller/gallery-canvas.go`; modify `service/gallery.go`, `service/gallery-storage.go`, `model/gallery-canvas.go`, `model/gallery.go`, `controller/gallery.go`, `router/api-router.go`, `service/gallery_test.go`. Keep these direct domain units, not a generic storage framework. GORM names the GalleryCanvas table `gallery_canvas`; use model-based queries rather than assuming an English plural. Linked images retain bounded safe generation metadata for existing preview/search; widen only GalleryImage Prompt/NegativePrompt/ParametersJSON with size:-1 for valid Unicode payloads and account their bytes. The canvas document remains authoritative.

**Interfaces:** Consumes Task 1 normalization/schema. Produces wire routes above via `SaveGalleryCanvas(ctx context.Context,user int,reader *multipart.Reader) (*model.GalleryCanvas,error)`, `GetGalleryCanvas(ctx context.Context,user int,id string) (*model.GalleryCanvas,error)`, `DeleteGalleryCanvas(ctx context.Context,user int,id string,revision int64) error`, `DeleteGalleryCanvasAsset(ctx context.Context,user int,id,assetID string,revision int64) (*model.GalleryCanvas,error)`. Add list/search and budget query helpers preserving legacy callers. Persist only the last normalized request fingerprint (`MutationHash`, varchar(64)) and canonical ID map (`MutationAssetIDMapJSON`, size:-1) for reliable retry after exact legacy reuse. Include these in metadata byte accounting, clear on deletion/expiry, and reject altered manifests/viewport under the same mutation ID.

- [x] **Step 1: Add RED snapshot tests in service/gallery_test.go.** Extend galleryFixture cleanup to the new disposable tables. Implement fixture multipart using existing galleryMultipart patterns and fixed galleryPNG original bytes. Tests use owner IDs 41/42, UUID resource IDs and explicit fixture metadata. Required independent cases: successful create/reload original bytes; retry same mutation no duplicate/retention; new viewport no renewal; real settings/name edit renew; no-change retry at full quota returns last revision; new bytes/count above exact capacity leave old doc/assets untouched; staged failure releases only files actually removed; explicit delete blocks stale save; asset delete detaches references/mask/edges but retains other images; expiry returns `expired` without content; nonowner APIs/files deny; legacy gallery unaffected; masks count bytes only; duplicate asset refs only one original; metadata contributes storage. Race use channels, not sleep.

```go
saved := saveCanvasFixture(t, 41, 0, "mutation-a", galleryPNG(t))
before, err := service.GetGalleryCanvas(context.Background(), 41, saved.ID)
require.NoError(t, err)
require.NoError(t, service.DeleteGalleryCanvas(context.Background(), 41, saved.ID, before.Revision))
_, err = service.GetGalleryCanvas(context.Background(), 42, saved.ID)
assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
_, err = saveCanvasFixtureResult(t, 41, before.Revision, "mutation-b", galleryPNG(t))
assert.ErrorIs(t, err, model.ErrGalleryCanvasDeleted)
```

`saveCanvasFixture` and `saveCanvasFixtureResult` are test-only wrappers assembling the concrete metadata/multipart above and invoking the real service; expected IDs passed explicitly, never regenerate a different canvas in a stale-save test.
- [x] **Step 2: Run RED.** `go test ./service -run 'Gallery.*Canvas' -count=1`.
- [x] **Step 3: Implement single-lock publication.** Reuse galleryMu, writer/safe downloader/free-space helpers; do not call a locking exported method while already holding galleryMu. Validate metadata before file writes, owner/revision/removal state before admission. Check proposed count and total physical bytes (original+thumbnail+metadata) and disk headroom. Stream new parts using remaining budget, verify declared bytes/checksum + actual decodable type/dimensions. Associate owned ready assets by exact ID/checksum; reject missing/foreign/deleted IDs. Pending ownership rows make crash cleanup recoverable. Commit resources/document/mutation/revision in one DB transaction only after complete assets exist:

```go
err = model.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
    if err := tx.Save(&next).Error; err != nil { return err }
    return tx.Model(&model.GalleryImage{}).Where("user_id = ? AND canvas_id = ? AND state = ?", user, next.ID, "pending").Updates(map[string]any{"state": "ready", "expires_at": next.ExpiresAt}).Error
})
```

Normalize/hashes server-side, including name as real content. Retain previous immutable asset bytes until publication; replacing bytes uses a new ID. Cleanup provisional writes on failure; failed filesystem removal retains counted pending rows. Trim obsolete metadata only after file deletion succeeds. Explicit deletes record only IDs/revision/reason before cleanup; remove document contents and prompt/name on whole-canvas deletion/expiry. Keep persistent explicit resource removals, even after expiry; no lost tombstone by recreating expired canvas. Preserve old unlinked gallery rows; linked legacy DELETE delegates shared deletion logic. Normal cleanup removes expired cloud data, marks expired rather than deleted, and must not erase active staging under lock. Private reads require ready/unexpired owner.
- [x] **Step 4: Wire routes, error codes and lightweight budget usage.** Add code field to error envelope only for canvas states, preserve existing messages. Usage includes actual minimum remaining user/global/disk available bytes; required request cannot report can_save when still too large. Listing excludes reference/mask, supports validated sort/search and source. Parameters are query-bound, not SQL concatenation except fixed sort allowlist. Bound metadata structural size separately from streamed original quota; keep current timeouts/safe URL rules.
- [x] **Step 5: Run GREEN, full gallery suite and gofmt.** `go test ./service -run Gallery -count=1`, `go test ./controller ./router -run '^$'`, `git diff --check`. Controller verifies fresh/upgrade/idempotent migrations on real engines using disposable DBs before release.
- [x] **Step 6: Commit only task files.** `git commit -m "feat(canvas): save private shared cloud revisions"` after explicit path staging; report exact wire examples/error behavior and test evidence.

### Task 3: Shared browser repository, original-asset codec and migration

**Files:** Create `web/src/features/gallery/lib/canvas-document.ts`, `canvas-repository.ts`, `canvas-migration.ts` (legacy import policy), `web/src/features/gallery/__tests__/canvas-repository.test.ts`; modify gallery `types.ts`, old Drawing/NAI storage loaders only if needed for reusable migration access. If decoding uses object URLs, narrowly extend `drawing/lib/image-assets.ts` with lifecycle-owned URL recognition/revocation; do not accept arbitrary blob URLs globally.

**Interfaces:** Produces `LocalCanvas` and `CanvasBinary` types; functions below. Consumes existing DrawingDocument/NaiCanvasDocument and Task 1 wire asset-ref document. Actual backend wire types live in gallery/types.ts. Use IndexedDB native API, no dependency installation.

```ts
type CanvasBinary = { id: string; blob: Blob; role: CanvasAssetRole; nodeId: string; sha256: string }
type LocalCanvas = {
  id: string; userId: number; kind: CanvasKind; name: string;
  document: Record<string, unknown>; revision: number; cloudRevision: number;
  localSavedAt: number; cloudSavedRevision: number; expiresAt: number;
  status: 'local' | 'pending' | 'synced' | 'full' | 'conflict' | 'error';
  needsExplicitSave: boolean; removedAssetIds: string[]; deleted: boolean;
}
// encodeCanvas extracts real original Blobs + asset refs, never a saved URL placeholder.
encodeCanvas(kind: CanvasKind, document: DrawingDocument | NaiCanvasDocument): Promise<{document: Record<string, unknown>; assets: CanvasBinary[]}>
decodeCanvas(canvas: LocalCanvas, assets: CanvasBinary[]): Promise<DrawingDocument | NaiCanvasDocument>
saveLocalCanvas(canvas: LocalCanvas, assets: CanvasBinary[]): Promise<LocalCanvas>
loadLocalCanvas(userId: number, id: string): Promise<LocalCanvas | null>
listLocalCanvases(userId: number): Promise<LocalCanvas[]>
readCanvasAssets(userId: number, id: string): Promise<CanvasBinary[]>
removeLocalCanvasAsset(userId: number,id: string,assetId: string): Promise<LocalCanvas>
removeLocalCanvas(userId: number,id: string): Promise<void>
readCanvasUserState(userId: number): Promise<CanvasUserState>
writeCanvasUserState(userId: number,state: CanvasUserState): Promise<void>
```

`CanvasUserState` stores last-opened ID per kind, persistent cloud pause (reason/required bytes/images/lastQuotaCheck/notified), pending explicit canvas/asset removals. API needs transaction-safe update helpers where read-modify-write can race; one DB with user-scoped keys and asset ownership key. No token/session headers saved. Use actual blob completion, revoke runtime object URLs at lifecycle boundary.

The codec may take an optional typed context carrying existing binary roles by asset ID and a captured-session original-byte reader/abort signal; Task 4 owns the network/session facade. Do not infer newly imported/generated purpose from current reference selection. Legacy originals without reliable role metadata are migrated as imported reference resources, with all bytes/relations preserved and needsExplicitSave; do not add per-image classification UI or unresolved-role blocking state. Authoritative exact cloud matches may later establish generated roles. Existing cloud legacy gallery remains intact. Existing imageAssetToFile's reference-upload size guard is not a generated-original persistence quota. If runtime decoding creates object URLs, Task 4 must materialize originals for portable JSON export, not export session-lifetime URLs. Existing legacy loaders are `drawing/lib/canvas-storage.ts` and `nai/lib/canvas-storage.ts`; neither old database is deleted after migration.

- [x] **Step 1: Write RED native storage tests with existing fake IndexedDB boundary.** Multi-canvas/multiuser reload with PNG original equality; repeated ref creates one blob entry; name/settings/reference/mask/edges roundtrip; failed IDB transaction doesn't claim success; unknown sensitive settings stripped by existing parser; deletion prunes referencing nodes/edges/masks but other images remain; pending deletion retained across reopen; migrated historical drafts stay local/explicit-save; quota pause survives a repository reload. Use literal minimal Drawing/NAI fixture and exact original PNG bytes.

```ts
const encoded = await encodeCanvas('drawing', drawingWithSharedReference)
const saved = await saveLocalCanvas(localCanvas, encoded.assets)
const reloaded = await loadLocalCanvas(41, saved.id)
expect(reloaded?.name).toBe('测试画布')
expect(await loadLocalCanvas(42, saved.id)).toBeNull()
const originals = await readCanvasAssets(41, saved.id)
expect(originals).toHaveLength(2) // one original and one distinct mask
expect(new Uint8Array(await originals[0].blob.arrayBuffer())).toEqual(pngBytes)
```

- [x] **Step 2: Run RED.** `node node_modules/vitest/vitest.mjs run src/features/gallery/__tests__/canvas-repository.test.ts` from web.
- [x] **Step 3: Implement local-first repository/codec.** Store canvases, binary resources, user-state in one IndexedDB database; logical user-scoped ownership. Resolve data URIs and blob sources to actual Blob, fetch accessible remote originals through safe existing gallery-download rules (Task 4 may add a private transient safe-download endpoint only if browser CORS requires; it must not persist/count a cloud asset). Do not claim complete if download fails. Distinguish generated/reference role explicitly on new node insertion (Task 4); migration unknown origins don't fabricate links. Save binary and document atomically:

```ts
const transaction = db.transaction(['canvases', 'assets'], 'readwrite')
transaction.objectStore('canvases').put(nextCanvas, [canvas.userId, canvas.id])
for (const asset of assets) transaction.objectStore('assets').put(asset, [canvas.userId, canvas.id, asset.id])
await new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error)
  transaction.onerror = () => reject(transaction.error)
})
return nextCanvas
```

Only resolve saved status after oncomplete. Migration imports the existing per-user Drawing/NAI stores once into one named local project each, retaining old DB records; mark historical drafts needsExplicitSave. Don't autosave migration to server. Deleting local resource records removes only repository blobs and marks intended cloud removal; never delete source filesystem files. Explicit deletion dominates subsequent stale IDB writes using local removal markers and monotonically increasing revision/session-local epoch. Missing/expired cloud cache handling belongs Task 4.
- [x] **Step 4: Run GREEN, affected existing parser/persistence tests and typecheck.** `node --no-experimental-webstorage node_modules/@typescript/native-preview/bin/tsgo -b`, changed-file oxlint; no lockfile writes.
- [x] **Step 5: Commit scoped paths.** `git commit -m "feat(canvas): persist multi-canvas browser drafts and shared originals"`; report public types/signatures, migration behavior and evidence.

### Task 4: Editor lifecycle and durable cloud synchronization

**Files:** Create `web/src/features/gallery/lib/canvas-sync.ts`, `hooks/use-canvas-projects.ts`, `__tests__/canvas-sync.test.ts`; modify gallery/api.ts, existing Drawing/NAI persistence/generation hooks, drawing-store.ts, nai-drawing-store.ts, authenticated-layout.tsx and relevant logout integration. Add focused code files for editor bridges if either becomes unwieldy; stable interfaces below remain one facade.

**Interfaces:** Consumes Tasks 2/3. Produces session coordinator `syncCanvas(identity: GalleryIdentity, canvasId: string, reason: 'timer'|'leave'|'manual'): Promise<void>`, `flushCanvasSession(identity: GalleryIdentity): Promise<void>`, `checkCanvasCapacity(identity: GalleryIdentity, forceAfterDelete?: boolean): Promise<void>`, `deleteCanvasProject(identity: GalleryIdentity, canvasId: string): Promise<void>`, `deleteCanvasResource(identity: GalleryIdentity, canvasId: string, assetId: string): Promise<void>`, `openCanvasProject(identity: GalleryIdentity, canvasId: string, focusAssetId?: string): Promise<void>`, `createCanvasProject(identity: GalleryIdentity, kind: CanvasKind): Promise<LocalCanvas>`, `renameCanvasProject(identity: GalleryIdentity, canvasId: string, name: string): Promise<void>`. Reactive hook returns current canvas, local/cloud state and these actions for Task 5. Query keys include user ID; requests reuse existing session-bound API wrapper.

- [ ] **Step 1: Add RED fake-time/MSW tests at persistence/network boundaries.** Edit then <2s pending, >=2s IDB success; dirty timer at 5m once, untouched none; leave flush; known-full preserved after reinstantiate and no POSTs after timers/manual/navigation/logout; required budget remains too high after small deletion; successful quota restore resumes actual pending changes, not expired unchanged draft; local transaction failure prevents saved text; conflict keeps local doc; deletion aborts late generation/write; full state notify once across reload; session switch aborts old requests; eligible logout bounded at 5s. Real repository/state-machine with mocked network, no fake production methods.

```ts
await editCanvasPrompt('new prompt')
await vi.advanceTimersByTimeAsync(1999)
expect((await loadLocalCanvas(41, id))?.document).toEqual(before)
await vi.advanceTimersByTimeAsync(1)
expect((await loadLocalCanvas(41, id))?.status).toBe('pending')
await checkCanvasCapacity(identity)
await syncCanvas(identity, id, 'manual')
expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0)
```

`editCanvasPrompt` is a test helper using real Zustand editing actions; requests captured at HTTP transport. Derive before from literal fixture, not actual implementation output.
- [ ] **Step 2: Run RED.** Focused canvas-sync tests plus existing generation-autosave tests changed to assert shared local path, not old immediate cloud queue.
- [ ] **Step 3: Implement one coordinator per captured owner/session.** Two-second local debounce; no save promise reported complete before IDB. Active project selection per kind; choose full local first then background state check. Network uploads only referenced new binary resources; base revision/mutation ID stable across retries. Reconcile deleted state by removing local cache and queue/undo; expired state clears cloud mapping/status but keeps local data and marks unchanged snapshot needsExplicitSave. Conflict pauses overwrites and exposes deliberate reload action; no automatic merge. Distinguish meaningful document changes from viewport for retention and expired eligibility. Acquire original bytes in current generation session independently of cloud quota; cancelled jobs/canvas deletion/session mismatch discard late work.

```ts
if (canvas.deleted || canvas.status === 'conflict') return
const state = await readCanvasUserState(identity.userId!)
if (state.pause) return
if (canvas.needsExplicitSave && reason !== 'manual') return
if (canvas.revision === canvas.cloudSavedRevision) return
assertGalleryIdentity(identity)
// Revision/removal and required-budget preflight precedes multipart publication.
```

Track persistent pause reason and full-notified separately from volatile local saving/error; reset notification only on genuine resumed capacity. Read original bytes once from codec; do not double-store via queueGallerySave. Imported references and masks maintain explicit purpose from local binary metadata / the remote asset manifest, never from whether an image is currently referenced. Apply a save response's asset_id_map atomically to current local blobs/document and active editor, preserving edits made after upload began. Store mutations/deletion paths clear or prune undo history and abort active jobs so late results cannot resurrect resources. Ordinary uncommitted editing undo remains.
- [ ] **Step 4: Hook leave/logout without weakening auth.** Read OWASP Authentication and Session Management Cheat Sheets before changing logout; record affected ASVS controls/current stable version. Flush local immediately, allow eligible cloud synchronization maximum 5000ms with cancellation, then perform existing logout/reset regardless of errors. Known full bypasses cloud entirely. Pagehide/visibility/route switch is best effort; don't promise unload network success. Abort on session switch, no old session replay, revoke object URLs. Delete explicit resources immediately (even full), preserve offline deletion intentions and replay only after captured identity + ownership checks.
- [ ] **Step 5: Run GREEN, existing gallery/generation/persistence/auth affected tests, typecheck and lint.** Record HTTP-call assertions and quota/expiry distinction. No paid calls.
- [ ] **Step 6: Commit scoped paths.** `git commit -m "feat(canvas): synchronize local-first editor projects safely"`.

### Task 5: Unified gallery/canvas view, editor controls and Chinese save states

**Files:** Modify gallery/index.tsx, gallery components/types/API as needed; create business components `canvas-card.tsx`, `canvas-save-status.tsx`, `canvas-project-dialog.tsx`; modify drawing/nai editor headers, routes `_authenticated/canvas/`, gallery settings explanation and locales/static keys. Tests in gallery/__tests__/gallery.test.tsx plus focused `canvas-projects.test.tsx`.

**Interfaces:** Consumes Task 4 hooks/actions and Task 2 listing. Query param `canvas` identifies project, `image` identifies focus asset; validate via Zod. Existing top sections remain. Source links use precise canvas/node IDs; never legacy guesses.

- [ ] **Step 1: Read shadcn-ui project skill and actual shared component implementations/call sites.** Candidates ConfirmDialog/Dialog/EmptyState/LoadingState/ErrorState/GalleryPreview. Read approved `.superpowers/brainstorm/9743-1789086035/content/gallery-canvas-layout.html` for layout only; production gets real controls/data.
- [ ] **Step 2: Add RED user-visible tests.** Picture/canvas tabs, mixed local/remote results without duplicate linked ID, title search/source/sort/pagination, long titles/narrow layout contracts, original preview and exact source navigation/focus, canvas create/open/rename/delete confirmation, deleting image updates canvas and gallery, full persistent status with no popup loop, IDB failure offers existing export action, conflict requires explicit cloud reload, empty/loading/error states. Query roles/labels and outcomes, not whole class snapshots.

```tsx
await user.click(screen.getByRole('tab', { name: 'Canvases' }))
await user.click(screen.getByRole('button', { name: 'Delete canvas' }))
expect(screen.getByRole('alertdialog')).toBeVisible()
expect(screen.getByText('The canvas and its images will be deleted.')).toBeVisible()
await user.click(screen.getByRole('button', { name: 'Cancel' }))
expect(screen.getByText('测试画布')).toBeVisible()
```

- [ ] **Step 3: Run RED.** Focused gallery/canvas-projects component tests.
- [ ] **Step 4: Compose approved layout.** Image-first responsive cards with object-contain original preview; secondary source link separated from image click, thumbnail stacks for canvas covers, readable status line. Shared Tabs/Input/Select/pagination; no new general dialog implementation. Relevant editor header shows canvas name, new/open/rename/manual save/status; cloud conflict includes confirmed reload and local export. Delete confirmations cover whole-canvas/one-image/clear-replace synced canvas, and all toolbar/keyboard/context delete entrypoints route through the approved behavior. Focus via existing ReactFlow fitView/selection and highlight, with Chinese accessible label. Pagination/filter merges stable local and cloud identities; no reference/mask clutter or duplicate originals. Cloud missing originals fetch privately only when local incomplete. Source label absent on unrelated legacy items.

```tsx
<ConfirmDialog
  open={deleteTarget !== null}
  onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
  title={t('Delete canvas')}
  desc={t('The canvas and its images will be deleted.')}
  handleConfirm={confirmDelete}
/>
```

Read actual ConfirmDialog props before adapting; retained semantics are confirmation/cancel, not a new modal. i18n Chinese full status only after successful local write; otherwise show local error/pending. Replace gallery/index.tsx's existing 30-second usage/list polling: coordinator owns the pending-only minimum-five-minute capacity cadence, and gallery navigation/manual refresh cannot bypass the persisted pause quota-check timestamp. Listing refresh itself is user-driven or mutation-invalidated. Settings help explains cloud retention/count includes references; thumbnails/masks/docs share byte budget without resetting values.
- [ ] **Step 5: Focused frontend verification.** Run new/affected gallery and editor UI tests, actual typecheck bin, changed-file oxlint and scoped format check, and one production Rsbuild build. Do not repeat already-green broad suites. Browser visual QA uses fixed local images at desktop/mobile for the approved gallery layout, long title/status and source-image jump, no model calls. Controller performs browser QA; release CI supplies full-suite verification.
- [ ] **Step 6: Commit scoped paths.** `git commit -m "feat(gallery): unify image and canvas project views"`; record reused components, viewport checks and no fabricated source links.

## Controller final verification and release

- [ ] Confirm all task review gates and resolve cross-task gaps from the ledger.
- [ ] Confirm retained successful backend and real SQLite/MySQL/PostgreSQL migration/behavior evidence against final changed paths. Run only necessary focused checks after later changes, frontend typecheck/lint/build and browser QA; no repeated baseline seeding or broad test loops. Fresh and latest-release upgrade migrations were each run twice on all three engines, preserving legacy data/settings/indexes. Record actual commands/results in the plan-owned verification artifact. Never use production DB credentials for destructive fixtures; release CI must pass before rollout.
- [ ] Run actual private router unauthenticated/owner/other-user/root isolation harness, including file read and new canvas endpoints, with local fixed images.
- [ ] Generate a final full review package from `39a05a9cbe53e18319e6fc8d36f77637da7db157` to HEAD; review per requesting-code-review, single complete fix wave if necessary, scoped re-review.
- [ ] Verify intended commits only, no cache/user modifications staged. Push main and create a new unused date tag following remote release convention only after complete evidence; user has authorized these actions. Observe CI image success before VPS rollout, preserve old image/Compose backup and data mounts, verify health/API version; do not clean disks or unrelated services. If a required check cannot run, report it and do not claim compatible/release-ready.
- [ ] Preserve this plan's scratch/reports (no unrequested cleanup). Final handoff concise: implemented behavior, actual checks, commit/tag/deployment state and any real remaining caveat.
