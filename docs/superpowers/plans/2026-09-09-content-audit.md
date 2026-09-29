# 内容审计实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在默认关闭、root 可控的前提下，为全站代理请求增加按用户归档的文本与图片内容审计，并提供有容量、期限、脱敏、图片安全和失败隔离的后台查看能力。

**Architecture:** 使用 `content_audits` 元数据表和独立的本地压缩文件存储，元数据保存检索字段与相对文件引用，正文/缩略图不进入现有用量日志表。代理入口创建一次审计上下文，用可透传流式响应的 writer 捕获客户端可见响应；请求结束后以 best-effort 异步落盘，定时系统任务负责 TTL、孤儿文件和容量状态维护。root-only API 与现有安全审计日志对接，前端在系统设置中配置，在 `/usage-logs/content-audit` 查看。

**Tech Stack:** Go 1.25、Gin、GORM、SQLite/PostgreSQL/MySQL、gzip、AES-GCM、标准 `image` 编解码器、`golang.org/x/image`、React、TypeScript、TanStack Router/Query、React Hook Form、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-09-content-audit-design.md`

## Global Constraints

- 默认关闭；只有 root 能开启、修改策略、查看正文、下载缩略图和删除记录。
- 关闭后停止记录，不补录开关开启前的请求；不改变现有用量日志、计费日志、登录审计日志。
- 默认保留 7 天，可配置 1～30 天；单条请求最多 512 KB，单条响应最多 1 MB。
- 默认审计总容量 512 MB；80% 仅告警，95% 暂停新记录，清理后低于 80% 才恢复。
- 图片缩略图默认开启，最长边 1024px、单张不超过 300KB；不保存原始 Base64 或无上限原图。
- `Authorization`、`api-key`、`x-api-key`、`cookie`、`set-cookie`、`proxy-authorization`、`password`、`secret`、`token`、`access_token`、`refresh_token` 等字段统一替换为 `[已隐藏]`，普通 prompt 和模型正文保持原样。
- 审计写入失败、队列满、图片下载失败和磁盘不足不得改变正常代理响应；只能记录内部告警并在记录中标记未完整保存。
- 图片 URL 只允许 HTTP(S)，必须阻断 localhost、内网、链路本地、保留地址和重定向后的同类地址，并限制连接、总响应时间、MIME 和大小。
- 不触碰 PostgreSQL、Redis、Docker 缓存或用户备份目录；独立目录只保存内容审计文件。
- 不要暂存或提交现有无关改动：`docker-compose.yml`、`.tmp-go-cache/`、`backups/`、`docs/superpowers/plans/` 中已有计划文件、`web/pnpm-lock.yaml`。
- 新增页面文案进入现有 i18n；中文 locale 必须提供中文文案，未翻译 locale 使用英文回退，不在组件中散落硬编码英文说明。

---

### Task 1: 配置、数据库模型和迁移

**Files:**
- Create: `setting/content_audit_setting.go`
- Create: `model/content_audit.go`
- Create: `model/content_audit_test.go`
- Modify: `model/option.go`
- Modify: `model/main.go`
- Modify: `model/system_task.go`

**Interfaces:**
- `setting.ContentAuditSettings` 暴露 `Enabled bool`、`RetentionDays int`、`MaxRequestBytes int64`、`MaxResponseBytes int64`、`MaxStorageBytes int64`、`ImageThumbnailEnabled bool`。
- `setting.GetContentAuditSettings() *ContentAuditSettings` 返回进程内配置；配置注册名固定为 `content_audit`，选项键固定为 `content_audit.enabled`、`content_audit.retention_days`、`content_audit.max_request_bytes`、`content_audit.max_response_bytes`、`content_audit.max_storage_bytes`、`content_audit.image_thumbnail_enabled`。
- `setting.ValidateContentAuditOption(key, value string) error` 拒绝超出服务端范围的值：保留期 1～30 天，请求上限 1KB～8MB，响应上限 1KB～16MB，总容量 16MB～64GB，布尔值只能是 `true`/`false`。
- `model.ContentAudit` 保存 `id`、创建/过期时间、用户和渠道快照、模型/分组、请求 ID、上游请求 ID、请求路径、`kind`、流式标记、HTTP 状态、耗时、请求/响应大小、截断标记、脱敏版本、payload/thumbnail 相对引用、图片 MIME、图片结果 URL JSON、错误信息和存储字节数；索引覆盖用户+时间、渠道+时间、模型+时间、请求 ID、kind+时间、expires_at。
- `model.ContentAuditStorageState` 是 id=1 的单例行，保存已提交字节、预留字节、暂停标记、暂停原因和最近清理时间；迁移必须同时加入主库完整迁移和 fast migration 列表。
- `model.ListContentAudits(filter ContentAuditFilter, offset, limit int) ([]ContentAudit, int64, error)`、`GetContentAudit(id int64)`、`DeleteContentAudit(id int64)`、`DeleteExpiredContentAudits(now int64)`、`GetContentAuditStorageState()` 提供后续存储层和 API 使用。

- [ ] **Step 1: 写失败测试，固定默认值、键名和范围。**

```go
func TestContentAuditDefaultsAndValidation(t *testing.T) {
    cfg := setting.GetContentAuditSettings()
    require.False(t, cfg.Enabled)
    assert.Equal(t, 7, cfg.RetentionDays)
    assert.EqualValues(t, 512<<10, cfg.MaxRequestBytes)
    assert.EqualValues(t, 1<<20, cfg.MaxResponseBytes)
    assert.EqualValues(t, 512<<20, cfg.MaxStorageBytes)
    require.Error(t, setting.ValidateContentAuditOption("content_audit.retention_days", "31"))
    require.Error(t, setting.ValidateContentAuditOption("content_audit.max_storage_bytes", "1024"))
    require.NoError(t, setting.ValidateContentAuditOption("content_audit.enabled", "false"))
}
```

- [ ] **Step 2: 写失败测试，验证 `ContentAudit` 索引字段、过期删除和存储状态单例可在测试数据库中迁移。**

```go
func TestContentAuditMetadataLifecycle(t *testing.T) {
    truncateTables(t)
    require.NoError(t, DB.AutoMigrate(&ContentAudit{}, &ContentAuditStorageState{}))
    row := &ContentAudit{UserID: 7, Username: "audit-user", Kind: "text", RequestID: "req-1", ExpiresAt: 10, StorageBytes: 32}
    require.NoError(t, DB.Create(row).Error)
    state, err := GetContentAuditStorageState()
    require.NoError(t, err)
    assert.EqualValues(t, 1, state.ID)
    deleted, err := DeleteExpiredContentAudits(11)
    require.NoError(t, err)
    assert.EqualValues(t, 1, deleted)
}
```

- [ ] **Step 3: 在配置模块中注册默认值，在 `model/option.go` 的通用校验入口调用 `ValidateContentAuditOption`，并把两个模型加入 `migrateDB` 与 `migrateDBFast`；让 `InitOptionMap` 通过 `config.GlobalConfig.ExportAllConfigs()`暴露这些键。

- [ ] **Step 4: 实现模型、过滤器、分页查询、过期删除和状态单例初始化；删除元数据时只删除数据库行，文件删除由存储协调器执行。

- [ ] **Step 5: 运行聚焦测试并提交独立 commit。**

Run: `go test ./model ./setting/... -run 'ContentAudit|content_audit' -count=1`

Expected: 配置、迁移、索引和 CRUD 测试全部通过。

Commit: `feat: add content audit configuration and metadata`

### Task 2: 独立压缩、加密和容量预留存储

**Files:**
- Create: `service/content_audit_storage.go`
- Create: `service/content_audit_storage_test.go`
- Modify: `common/crypto.go`

**Interfaces:**
- `service.ContentAuditBlobRef` 包含 `Ref string`、`Bytes int64`、`Encrypted bool`。
- `model.ContentAuditStorageStatus` 包含 `UsedBytes`、`MaxBytes`、`WarningBytes`、`PauseBytes`、`UsagePercent`、`RecordCount`、`OldestExpiresAt`、`LastCleanupAt`、`Paused`、`PauseReason` 和 `StableCryptoConfigured`。
- `service.StoreContentAuditBlob(ctx context.Context, kind string, data []byte) (ContentAuditBlobRef, error)` 压缩后写入独立 `new-api-content-audit` 目录，返回随机相对引用，不接受用户输入作为文件名。
- `service.LoadContentAuditBlob(ref string) ([]byte, error)` 只接受不含 `..`、路径分隔符和绝对路径的相对引用，并校验文件确实位于审计目录。
- `service.DeleteContentAuditBlob(ref string) error`、`ReconcileContentAuditStorage(ctx context.Context) error`、`GetContentAuditStorageStatus() (model.ContentAuditStorageStatus, error)` 对应文件删除、孤儿回收和设置页状态。
- `service.TryReserveContentAuditBytes(size int64) (bool, error)`、`CommitContentAuditBytes(reserved, committed int64) error`、`ReleaseContentAuditBytes(size int64) error` 使用 `ContentAuditStorageState` 的 `ReservedBytes`/`UsedBytes`，在 95% 前阻止新记录并在低于 80% 时恢复。

- [ ] **Step 1: 写失败测试，验证压缩往返、路径穿越拒绝、容量阈值和稳定密钥行为。**

```go
func TestContentAuditStorageRejectsTraversalAndHonorsCapacity(t *testing.T) {
    t.Setenv("CONTENT_AUDIT_PATH", t.TempDir())
    ref, err := StoreContentAuditBlob(context.Background(), "payload", []byte("hello"))
    require.NoError(t, err)
    restored, err := LoadContentAuditBlob(ref.Ref)
    require.NoError(t, err)
    assert.Equal(t, []byte("hello"), restored)
    assert.Error(t, func() error { _, err := LoadContentAuditBlob("../secret"); return err }())
}
```

- [ ] **Step 2: 实现目录解析：优先使用 `CONTENT_AUDIT_PATH`，未设置时使用现有磁盘缓存根目录或系统临时目录下的 `new-api-content-audit` 子目录；创建目录权限为 0700，文件权限为 0600。

- [ ] **Step 3: 在 `common/crypto.go` 增加 `StableCryptoSecretConfigured() bool`，实现 gzip 压缩；当该函数返回 true 时，用 `sha256("new-api-content-audit-v1:" + common.CryptoSecret)` 派生 AES-256-GCM 密钥，文件写入版本头、随机 nonce 和密文；返回 false 时写入压缩明文并让状态 API返回“仅依赖主机文件权限保护”。

- [ ] **Step 4: 实现容量预留与提交：先在事务中锁定 id=1 状态行，检查 `UsedBytes + ReservedBytes + size <= MaxStorageBytes * 0.95`，再增加预留；落盘成功和元数据写入成功后把预留转为已用，任一步失败都释放预留；清理任务按实际文件大小重算状态。

- [ ] **Step 5: 实现孤儿文件扫描，只删除不在数据库引用集合中的审计文件；绝不扫描或删除 `new-api-body-cache`、备份目录和日志目录。

- [ ] **Step 6: 运行聚焦测试并提交独立 commit。**

Run: `go test ./service -run 'ContentAuditStorage|ContentAudit' -count=1`

Expected: 压缩/解压、加密/无密钥降级、路径校验、预留和 80%/95% 状态测试全部通过。

Commit: `feat: add content audit blob storage and capacity guard`

### Task 3: 脱敏、截断和图片结果提取

**Files:**
- Create: `service/content_audit_payload.go`
- Create: `service/content_audit_payload_test.go`
- Create: `service/content_audit_image.go`
- Create: `service/content_audit_image_test.go`

**Interfaces:**
- `service.BuildContentAuditRequestPayload(request any, maxBytes int64) (text string, truncated bool, err error)` 将已解析的客户端 DTO转换为 JSON，递归脱敏凭据字段，去掉输入图片的完整 Base64/data URI，只保留类型和字节数，再按 UTF-8 安全边界截断。
- `service.CaptureContentAuditResponse(data []byte, maxBytes int64) (text string, truncated bool)` 对客户端可见文本/SSE响应执行同样的大小限制；不把完整二进制音频写入审计 payload。
- `service.ExtractContentAuditImages(response []byte) (urls []string, base64Images [][]byte, err error)` 读取 OpenAI 兼容 `data[].url`/`data[].b64_json`，只返回待处理结果，不把原始 Base64写进元数据。
- `service.FetchContentAuditThumbnail(ctx context.Context, rawURL string) (thumbnail []byte, mime string, err error)` 通过 SSRF 安全客户端下载并压缩为最长边 1024px、最大 300KB 的 JPEG/WebP兼容缩略图。

- [ ] **Step 1: 写失败测试，覆盖敏感字段、普通 prompt、输入图片 Base64、截断标志、URL/b64_json 两种图片响应。**

```go
func TestBuildContentAuditRequestPayloadRedactsCredentialsButKeepsPrompt(t *testing.T) {
    raw := map[string]any{
        "messages": []any{map[string]any{"role": "user", "content": "保留这段 prompt"}},
        "headers": map[string]any{"Authorization": "Bearer secret", "x-api-key": "key"},
        "image": "data:image/png;base64," + strings.Repeat("A", 1000),
    }
    payload, _, err := BuildContentAuditRequestPayload(raw, 4096)
    require.NoError(t, err)
    assert.Contains(t, payload, "保留这段 prompt")
    assert.NotContains(t, payload, "Bearer secret")
    assert.NotContains(t, payload, strings.Repeat("A", 100))
}
```

- [ ] **Step 2: 实现递归 key 脱敏、二进制字段摘要和 UTF-8安全截断；脱敏版本固定为 `content-audit-redaction-v1`，由捕获上下文写入元数据。

- [ ] **Step 3: 实现图片结果提取；URL 只保存到 `ContentAudit.ImageResultURLs`，`b64_json` 进入缩略图处理后立即释放，不进入日志、错误文本或数据库字段。

- [ ] **Step 4: 实现 SSRF 防护：解析 URL 时拒绝 scheme/userinfo/非标准端口异常；自定义 `net.Dialer` 对每个解析 IP执行 loopback、private、link-local、multicast、unspecified 和保留地址检查；`CheckRedirect` 对每次重定向重新验证；连接超时 3 秒、总超时 10 秒、响应读取上限 4MB，要求真实 MIME为 `image/*`。

- [ ] **Step 5: 用 `image.DecodeConfig` 校验尺寸，用 `image.Decode` 缩放最长边至 1024px，再以 JPEG质量 82开始压缩；超过 300KB时按质量 72、60、48 重试，仍超限则放弃缩略图但保留 URL和错误原因。

- [ ] **Step 6: 运行聚焦测试并提交独立 commit。**

Run: `go test ./service -run 'ContentAuditPayload|ContentAuditImage' -count=1`

Expected: 脱敏、截断、SSRF、MIME、尺寸和缩略图大小测试全部通过。

Commit: `feat: sanitize and thumbnail audited content`

### Task 4: 代理入口捕获与 best-effort 异步写入

**Files:**
- Create: `service/content_audit_capture.go`
- Create: `service/content_audit_capture_test.go`
- Modify: `controller/relay.go`

**Interfaces:**
- `service.ContentAuditRequestMeta` 包含用户 ID/名称、渠道 ID/名称/类型、模型、分组、请求 ID、请求路径、kind、流式标记和创建时间。
- `service.NewContentAuditCapture(c *gin.Context) *ContentAuditCapture` 在开关关闭、容量保护、非文本/图片 relay 或 WebSocket realtime 时返回 nil；开启后只分配受限响应缓冲。
- `service.NewContentAuditCaptureForTest(c *gin.Context, maxResponseBytes int64) *ContentAuditCapture` 只在测试中构造固定上限的 capture，避免测试依赖全局容量状态。
- `(*ContentAuditCapture).Activate(meta ContentAuditRequestMeta, request any) error` 捕获认证、模型解析后的客户端语义请求；retry 选到实际渠道时允许 `UpdateChannel(id, name, type)` 更新快照。
- `(*ContentAuditCapture).WrapWriter(c *gin.Context)` 安装兼容 Gin 的 writer，透传 `WriteHeader`、`Write`、`WriteString`、`Flush`、`Hijack`、`CloseNotify` 和 `Pusher`，只在内存中保留响应上限字节。
- `(*ContentAuditCapture).CapturedResponse() []byte` 返回受限响应副本，仅供单元测试和 Finalize 内部使用。
- `(*ContentAuditCapture).Finalize(status int, upstreamRequestID string)` 在响应/error defer完成后复制受限内容，异步执行 payload 脱敏、图片处理、文件写入和 `model.ContentAudit` 插入；任何内部错误只写告警和失败原因。

- [ ] **Step 1: 写失败测试，验证开关关闭不建表记录，开启后文本请求按用户/请求 ID归档，512KB/1MB截断标志正确，流式 writer 不改变客户端字节。**

```go
func TestContentAuditCaptureDoesNotChangeStream(t *testing.T) {
    recorder := httptest.NewRecorder()
    ctx, _ := gin.CreateTestContext(recorder)
    capture := NewContentAuditCaptureForTest(ctx, 8)
    capture.WrapWriter(ctx)
    _, err := ctx.Writer.Write([]byte("123456789"))
    require.NoError(t, err)
    assert.Equal(t, "123456789", recorder.Body.String())
    assert.Equal(t, []byte("12345678"), capture.CapturedResponse())
}
```

- [ ] **Step 2: 在 `controller.Relay` 的最外层安装 capture writer，并把 Finalize defer 放在现有错误写入 defer之后，使失败 JSON也能被捕获；只有 `GetAndValidateRequest`、`GenRelayInfo` 成功后调用 `Activate`，因此匿名/非法请求不会写入正文。

- [ ] **Step 3: 从 `RelayInfo` 和选中渠道构造元数据；retry 期间更新渠道快照；从 `c.GetString(common.UpstreamRequestIdKey)` 读取上游 request id；`messages/count_tokens`、音频、embedding、rerank、MJ和 realtime 明确跳过。

- [ ] **Step 4: 使用有限异步队列（容量 128）；队列满时记录 `capture_queue_full` 告警并让请求继续；后台 worker 使用独立 context 和 15 秒图片/文件处理超时。

- [ ] **Step 5: 运行 relay/controller 回归测试并提交独立 commit。**

Run: `go test ./controller ./relay/... -run 'ContentAudit|Relay|Responses|Image' -count=1`

Expected: 捕获关闭/开启、流式透传、失败响应、retry 快照和异步失败隔离测试全部通过。

Commit: `feat: capture relay content for audit`

### Task 5: TTL 清理、容量恢复和系统任务

**Files:**
- Create: `service/content_audit_cleanup.go`
- Create: `service/content_audit_cleanup_test.go`
- Modify: `model/system_task.go`
- Modify: `service/system_task.go`

**Interfaces:**
- 新任务类型固定为 `model.SystemTaskTypeContentAuditCleanup = "content_audit_cleanup"`。
- `contentAuditCleanupHandler` 实现 `ScheduledSystemTaskHandler`：`Type()` 返回上述类型，`Enabled()` 始终为 true，`Interval()` 为 `time.Hour`，`NewPayload()` 返回 nil。
- `service.RunContentAuditCleanup(ctx context.Context, now int64) error` 执行一次完整清理，handler 直接调用该函数，测试也通过该公开入口验证结果。
- `Run` 先删除 `expires_at <= now` 的记录和引用文件，再扫描并回收孤儿文件，最后重算 `UsedBytes`、清零 `ReservedBytes`、在低于 80% 时清除暂停标记并更新 `LastCleanupAt`。
- 清理任务必须可在多节点 runner 中安全重复执行；元数据删除和状态更新使用事务，文件删除失败保留失败计数并继续处理其他记录。

- [ ] **Step 1: 写失败测试，覆盖 TTL 删除、孤儿文件、文件删除失败继续执行、80%恢复和95%暂停。**

```go
func TestContentAuditCleanupRestoresCaptureAfterUsageFallsBelowWarning(t *testing.T) {
    state := model.ContentAuditStorageState{ID: 1, UsedBytes: 512 << 20, Paused: true}
    require.NoError(t, model.DB.Save(&state).Error)
    require.NoError(t, RunContentAuditCleanup(context.Background(), time.Now().Unix()))
    refreshed, err := model.GetContentAuditStorageState()
    require.NoError(t, err)
    assert.False(t, refreshed.Paused)
}
```

- [ ] **Step 2: 注册 handler；保留现有 log cleanup 的手动任务行为，不复用其 payload 或表。

- [ ] **Step 3: 实现按小时清理、状态重算和失败告警；清理以数据库引用为准，不删除任何其他缓存目录。

- [ ] **Step 4: 运行任务测试并提交独立 commit。**

Run: `go test ./service ./model -run 'ContentAuditCleanup|SystemTask' -count=1`

Expected: 定时注册、过期删除、孤儿回收和容量恢复测试全部通过。

Commit: `feat: schedule content audit cleanup`

### Task 6: root-only API、正文读取和安全审计

**Files:**
- Create: `controller/content_audit.go`
- Create: `controller/content_audit_test.go`
- Modify: `router/api-router.go`
- Modify: `middleware/auth.go`
- Modify: `middleware/audit.go`

**Interfaces:**
- `GET /api/content-audit/status` 返回记录数、已用/上限/百分比、80%/95%阈值、暂停状态/原因、最早过期时间、最近清理时间和是否配置稳定加密密钥。
- `GET /api/content-audit` 接受 `p`、`page_size`、`user_id`、`username`、`start_timestamp`、`end_timestamp`、`channel_id`、`model`、`kind`、`status`、`request_id`，返回不含正文的分页元数据。
- `GET /api/content-audit/:id` 返回元数据和解压后的脱敏 request/response 文本；不返回真实文件路径，不接受 URL 参数传递正文。
- `GET /api/content-audit/:id/thumbnail` 以图片响应返回缩略图；没有缩略图时返回明确的 404 业务错误。
- `DELETE /api/content-audit/:id` 删除一条记录及引用文件；`POST /api/content-audit/cleanup` 触发一次已有的清理任务并返回任务状态。
- 所有 content-audit 路由先通过 `RootAuth`，再拒绝 `use_access_token=true` 的 API token，仅允许 root dashboard session；查看正文、下载缩略图、删除和手动清理分别写入 `content_audit.view`、`content_audit.download`、`content_audit.delete`、`content_audit.cleanup` 安全审计操作，参数只含 record id/筛选摘要，不写正文。

- [ ] **Step 1: 写失败测试，验证普通用户/管理员、root PAT、root session 的权限差异，查询过滤、分页、正文脱敏和不存在缩略图的错误状态。**

```go
func TestContentAuditBodyRequiresRootDashboardSession(t *testing.T) {
    router, rootPAT := newContentAuditTestRouter(t)
    request := httptest.NewRequest(http.MethodGet, "/api/content-audit/1", nil)
    request.Header.Set("Authorization", "Bearer "+rootPAT)
    response := httptest.NewRecorder()
    router.ServeHTTP(response, request)
    assert.Equal(t, http.StatusForbidden, response.Code)
}
```

`newContentAuditTestRouter` 必须在同一测试文件中创建 SQLite 主库、root 用户、root PAT 和有效 dashboard session，并分别注册 `RootSessionAuth` 路由；测试代码不能依赖真实环境凭据。

- [ ] **Step 2: 添加 `middleware.RootSessionAuth`，复用 `RootAuth` 的认证与角色检查，在 `use_access_token` 为 true 或 session identity 缺失时返回 403。

- [ ] **Step 3: 实现过滤器白名单、page size 上限 100、元数据分页和详情 payload 读取；读取失败只返回通用错误并写内部告警。

- [ ] **Step 4: 注册路由；在 `middleware.auditRouteActions` 中加入清理动作，详情/缩略图/删除动作由 controller 手动 `RecordOperationAuditLog`，确保不会被通用兜底重复记录。

- [ ] **Step 5: 运行 API/安全审计测试并提交独立 commit。**

Run: `go test ./controller ./middleware ./router -run 'ContentAudit|Audit|RootSession' -count=1`

Expected: root-only、正文不可由 PAT 读取、查询/删除和安全审计日志测试全部通过。

Commit: `feat: expose root-only content audit APIs`

### Task 7: 系统设置中的内容审计配置和容量状态

**Files:**
- Create: `web/src/features/system-settings/maintenance/content-audit-section.tsx`
- Create: `web/src/features/system-settings/__tests__/content-audit-settings.test.tsx`
- Modify: `web/src/features/system-settings/operations/section-registry.tsx`
- Modify: `web/src/features/system-settings/operations/index.tsx`
- Modify: `web/src/features/system-settings/types.ts`
- Modify: `web/src/features/system-settings/api.ts`
- Modify: `web/src/i18n/locales/en.json`
- Modify: `web/src/i18n/locales/zh.json`
- Modify: `web/src/i18n/locales/zh-TW.json`
- Modify: `web/src/i18n/locales/ja.json`
- Modify: `web/src/i18n/locales/fr.json`
- Modify: `web/src/i18n/locales/ru.json`
- Modify: `web/src/i18n/locales/vi.json`

**Interfaces:**
- `OperationsSettings` 增加六个 `content_audit.*` 字段，默认值与 Go 配置一致；section id 固定为 `content-audit`，标题为 `Content Audit`。
- `getContentAuditStatus()` 调用 `/api/content-audit/status`，返回 `used_bytes`、`max_bytes`、`usage_percent`、`record_count`、`oldest_expires_at`、`last_cleanup_at`、`paused`、`pause_reason`、`stable_crypto_configured`。
- `ContentAuditSection` 使用现有 `SettingsForm`/`SettingsControlGroup`/`useUpdateOption`，保存开关、保留期、请求/响应/总容量、图片缩略图；数字输入在前端仅做即时范围提示，最终以服务端校验为准。
- 状态区域显示容量进度、80%警告、95%暂停、无稳定密钥提示、记录数和最近清理时间；刷新状态不会重新读取代理内容。

- [ ] **Step 1: 写失败前端测试，验证默认值、中文标签、数字范围提示、容量进度和暂停警告。**

```tsx
test('shows content audit capacity warning without exposing payload', async () => {
  render(
    <ContentAuditSection
      defaultValues={{
        'content_audit.enabled': false,
        'content_audit.retention_days': 7,
        'content_audit.max_request_bytes': 512 * 1024,
        'content_audit.max_response_bytes': 1024 * 1024,
        'content_audit.max_storage_bytes': 512 * 1024 * 1024,
        'content_audit.image_thumbnail_enabled': true,
      }}
    />
  )
  expect(screen.getByText('内容审计')).toBeInTheDocument()
  expect(screen.getByText(/95%/)).toBeInTheDocument()
  expect(screen.queryByText(/Authorization|api-key/i)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: 扩展系统设置类型、默认设置、operations registry 和 API 类型；新增 section 不改变其他 section 的 URL或默认顺序。

- [ ] **Step 3: 实现表单提交和状态查询；切换关闭只停止新记录，不触发历史删除；保存失败显示服务端中文错误。

- [ ] **Step 4: 为新增 key 添加中文、英文和其他 locale 回退文案，运行 i18n 同步脚本并确认 JSON 格式有效。

- [ ] **Step 5: 运行前端聚焦测试并提交独立 commit。**

Run: `cd web && pnpm exec vitest run src/features/system-settings/__tests__/content-audit-settings.test.tsx`

Expected: 设置表单和状态提示测试全部通过。

Commit: `feat: add content audit settings panel`

### Task 8: root-only 内容审计查看页和导航

**Files:**
- Create: `web/src/features/content-audit/api.ts`
- Create: `web/src/features/content-audit/types.ts`
- Create: `web/src/features/content-audit/index.tsx`
- Create: `web/src/features/content-audit/components/content-audit-filter-bar.tsx`
- Create: `web/src/features/content-audit/components/content-audit-table.tsx`
- Create: `web/src/features/content-audit/components/content-audit-detail-dialog.tsx`
- Create: `web/src/features/content-audit/__tests__/viewer.test.tsx`
- Create: `web/src/routes/_authenticated/usage-logs/content-audit.tsx`
- Modify: `web/src/hooks/use-sidebar-data.ts`
- Modify: `web/src/hooks/use-sidebar-config.ts`
- Modify: `web/src/features/system-settings/maintenance/config.ts`
- Modify: `web/src/features/system-settings/maintenance/sidebar-modules-section.tsx`
- Modify: `web/src/features/profile/components/sidebar-modules-card.tsx`
- Modify: `web/src/i18n/locales/en.json`
- Modify: `web/src/i18n/locales/zh.json`
- Modify: `web/src/i18n/static-keys.ts`

**Interfaces:**
- 页面固定地址为 `/usage-logs/content-audit`；路由 `beforeLoad` 只允许 `ROLE.SUPER_ADMIN`，非 root 重定向 `/403`。
- `getContentAudits(filters)` 对应分页查询，`getContentAuditDetail(id)` 对应详情，`getContentAuditThumbnailUrl(id)` 只产生前端 API 请求地址，不拼本地路径，`deleteContentAudit(id)` 删除后刷新列表。
- 表格列显示时间、用户、渠道、模型、kind、状态、耗时、截断标记、缩略图可用性和请求 ID；详情弹窗分区显示请求、响应、图片参数/结果 URL、错误和截断提示，复制只复制已脱敏文本。
- 导航新增 `contentAudit` 模块，默认放在 console 的 `audit` 后面，且 `useSidebarData` 设置 `requiredRole: ROLE.SUPER_ADMIN`；旧版 sidebar JSON 经过 `mergeWithDefaultSidebarModules` 后自动补齐新模块。

- [ ] **Step 1: 写失败前端测试，验证 root 页面、用户/时间/渠道/模型/request id/kind/status 筛选、分页、截断徽标、详情折叠和删除刷新。**

```tsx
test('renders filters and keeps audited payload behind detail action', async () => {
  render(<ContentAudit />)
  expect(screen.getByPlaceholderText('按用户筛选')).toBeInTheDocument()
  expect(screen.getByPlaceholderText('按请求 ID 筛选')).toBeInTheDocument()
  expect(screen.queryByText('模型回复正文')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '查看详情' }))
  expect(await screen.findByText('模型回复正文')).toBeInTheDocument()
})
```

- [ ] **Step 2: 创建 route 文件并让 TanStack Router 生成 `web/src/routeTree.gen.ts`；路由守卫失败时不请求内容 API。

- [ ] **Step 3: 实现 API 类型、筛选栏、分页表格和详情弹窗；图片缩略图使用 root session 的同源请求，下载失败显示“缩略图不可用”，不显示真实文件引用。

- [ ] **Step 4: 更新侧边栏默认/用户配置合并、个人侧边栏配置卡和中文文案；普通用户即使旧配置包含新 key 也不能通过路由访问。

- [ ] **Step 5: 运行前端聚焦测试并提交独立 commit。**

Run: `cd web && pnpm exec vitest run src/features/content-audit/__tests__/viewer.test.tsx src/hooks/__tests__/sidebar-config.test.tsx`

Expected: 页面权限、筛选、详情和导航兼容测试全部通过。

Commit: `feat: add content audit viewer`

### Task 9: 集成验证、文档和发布前检查

**Files:**
- Create: `docs/content-audit.md`
- Modify: `web/src/i18n/static-keys.ts`

**Interfaces:**
- `docs/content-audit.md` 说明默认关闭、root 设置路径、查看地址 `/usage-logs/content-audit`、默认限制、容量暂停规则、稳定密钥提示、关闭后不补录和图片 URL 可能过期的行为。
- 发布检查必须能从空数据库启动、从已有数据库自动迁移、在 `CONTENT_AUDIT_PATH` 临时目录运行，并确认 Docker 构建不把审计目录复制进镜像层。

- [ ] **Step 1: 运行完整后端测试。**

Run: `go test ./common ./model ./service ./middleware ./controller ./router ./relay/... -count=1`

Expected: exit code 0，所有测试通过。

- [ ] **Step 2: 运行完整前端验证。**

Run: `cd web && pnpm run test && pnpm run build:check && pnpm run i18n:sync`

Expected: Vitest、TypeScript/Rsbuild 检查和 i18n 同步均成功，生成的 `routeTree.gen.ts` 与源路由一致。

- [ ] **Step 3: 运行格式与敏感内容检查。**

Run: `gofmt -w common/crypto.go setting/content_audit_setting.go model/content_audit.go service/content_audit_storage.go service/content_audit_payload.go service/content_audit_image.go service/content_audit_capture.go service/content_audit_cleanup.go controller/content_audit.go`; 随后运行 `git diff --check` 和 `rg -n 'Authorization:|Bearer |api[-_]?key|cookie|refresh_token' service/content_audit* model/content_audit* controller/content_audit*`。

Expected: 无格式错误；测试夹具之外不出现凭据落盘或日志输出；工作区无未解释的新增大文件。

- [ ] **Step 4: 对照 spec 做逐项验收：默认关闭、TTL、单条/总容量、80%/95%阈值、脱敏、图片 SSRF、失败隔离、root session、查看/下载/删除审计日志、旧导航配置兼容全部有测试或运行证据。

- [ ] **Step 5: 只暂存本功能文件，创建最终 commit；提交前再次确认 `git status --short` 中不包含现有用户改动，暂不创建 tag、暂不推送、暂不部署，等待用户后续确认。**

Commit: `feat: add root-only content audit`
