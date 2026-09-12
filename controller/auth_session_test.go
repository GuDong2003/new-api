package controller

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestAuthLogoutRejectsRefreshCookieSessionMismatch(t *testing.T) {
	previousDB := model.DB
	previousRedis := common.RedisEnabled
	previousSecret := common.SessionSecret
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}))
	model.DB = db
	common.RedisEnabled = false
	common.SessionSecret = "auth-logout-mismatch-test-secret"
	t.Cleanup(func() {
		model.DB = previousDB
		common.RedisEnabled = previousRedis
		common.SessionSecret = previousSecret
	})

	user := &model.User{
		Username: "logout-mismatch-user", Password: "unused", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1,
	}
	require.NoError(t, db.Create(user).Error)
	sessionA, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "agent-a")
	require.NoError(t, err)
	sessionB, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "agent-b")
	require.NoError(t, err)

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/user/auth/logout", nil)
	c.Request.Header.Set("Authorization", "Bearer "+sessionA.AccessToken)
	c.Request.Header.Set("X-Auth-Session", sessionA.Session.SID)
	c.Request.AddCookie(&http.Cookie{Name: service.RefreshCookieName, Value: sessionB.RefreshToken})

	AuthLogout(c)

	assert.Equal(t, http.StatusConflict, recorder.Code)
	var response struct {
		Success bool   `json:"success"`
		Code    string `json:"code"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	assert.False(t, response.Success)
	assert.Equal(t, "AUTH_SESSION_MISMATCH", response.Code)
	for _, sid := range []string{sessionA.Session.SID, sessionB.Session.SID} {
		stored, err := model.GetUserSessionBySID(sid)
		require.NoError(t, err)
		assert.Equal(t, model.UserSessionStatusActive, stored.Status)
	}
}

func TestWriteAuthSessionErrorMapsSessionGrowthLimits(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name           string
		err            error
		expectedStatus int
		expectedCode   string
	}{
		{
			name:           "active session limit",
			err:            model.ErrUserSessionLimit,
			expectedStatus: http.StatusConflict,
			expectedCode:   "AUTH_SESSION_LIMIT",
		},
		{
			name:           "issuance limit",
			err:            model.ErrUserSessionIssuanceLimit,
			expectedStatus: http.StatusTooManyRequests,
			expectedCode:   "AUTH_SESSION_ISSUANCE_LIMIT",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			writeAuthSessionError(c, test.err)

			assert.Equal(t, test.expectedStatus, recorder.Code)
			var response struct {
				Success bool   `json:"success"`
				Code    string `json:"code"`
			}
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
			assert.False(t, response.Success)
			assert.Equal(t, test.expectedCode, response.Code)
		})
	}
}

func TestSessionLimitDoesNotRecordRejectedLoginAsSuccessful(t *testing.T) {
	previousDB := model.DB
	previousRedis := common.RedisEnabled
	previousActiveLimit := common.UserSessionActiveLimit
	previousIssuanceLimit := common.UserSessionIssuanceLimit
	previousIssuanceWindow := common.UserSessionIssuanceWindowSeconds
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}, &model.TwoFA{}, &model.PasskeyCredential{}))
	model.DB = db
	common.RedisEnabled = false
	common.UserSessionActiveLimit = 1
	common.UserSessionIssuanceLimit = 100
	common.UserSessionIssuanceWindowSeconds = int64(common.DefaultUserSessionIssuanceWindowSeconds)
	t.Cleanup(func() {
		model.DB = previousDB
		common.RedisEnabled = previousRedis
		common.UserSessionActiveLimit = previousActiveLimit
		common.UserSessionIssuanceLimit = previousIssuanceLimit
		common.UserSessionIssuanceWindowSeconds = previousIssuanceWindow
	})

	const previousLastLoginAt = int64(123)
	user := &model.User{
		Username: "rejected-login-audit-user", Password: "unused", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, LastLoginAt: previousLastLoginAt,
	}
	require.NoError(t, db.Create(user).Error)
	now := time.Now().Unix()
	require.NoError(t, db.Create(&model.UserSession{
		SID: "existing-active-session", UserID: user.Id, Version: 1, UserAuthVersion: user.AuthVersion,
		Status: model.UserSessionStatusActive, RefreshHash: "hash", LoginMethod: "password",
		CreatedAt: now, LastActiveAt: now, ExpiresAt: now + 3600,
	}).Error)

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/user/login", nil)
	setupLogin(user, c)

	assert.Equal(t, http.StatusConflict, recorder.Code)
	var stored model.User
	require.NoError(t, db.First(&stored, user.Id).Error)
	assert.Equal(t, previousLastLoginAt, stored.LastLoginAt)
}

func contentAuditManagementFixture(t *testing.T) (*model.User, service.AuthIdentity, string, *gin.Engine) {
	t.Helper()
	t.Setenv("TEST_SECURITY_DIALECT", "sqlite")
	t.Setenv("CONTENT_AUDIT_STORAGE_DIR", "")
	user, identity := setupSecurityEnrollmentTest(t)
	require.NoError(t, model.DB.Model(user).Update("role", common.RoleRootUser).Error)
	user.Role = common.RoleRootUser
	require.NoError(t, model.PublishUserAuthCache(user.Id))
	require.NoError(t, model.MigrateContentAudit(model.DB))
	token, _, err := service.IssueAccessToken(identity)
	require.NoError(t, err)
	router := gin.New()
	group := router.Group("/api/content-audit", middleware.DisableCache(), middleware.RootAuth(), middleware.ContentAuditSessionAuth())
	group.GET("/settings", GetContentAuditSettings)
	group.GET("/status", GetContentAuditStatus)
	group.POST("/initialize", InitializeContentAudit)
	group.GET("/records", ListContentAudits)
	group.GET("/records/:id", GetContentAuditDetail)
	group.GET("/records/:id/images", GetContentAuditImagePage)
	group.GET("/records/:id/originals/:index", GetContentAuditOriginal)
	group.GET("/records/:id/thumbnails/:index", GetContentAuditThumbnail)
	group.PUT("/settings", UpdateContentAuditSettings)
	group.POST("/records/delete", DeleteContentAudits)
	group.DELETE("/records/:id", DeleteContentAudits)
	group.POST("/records/reset", ResetContentAudits)
	return user, identity, token, router
}

func contentAuditManagementRequest(router *gin.Engine, method, path, token, proof string, body []byte) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Security-Proof", proof)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

type contentAuditInterruptingWriter struct {
	*httptest.ResponseRecorder
	afterFirstWrite func()
}

func (w *contentAuditInterruptingWriter) Write(data []byte) (int, error) {
	n, err := w.ResponseRecorder.Write(data)
	if w.afterFirstWrite != nil {
		action := w.afterFirstWrite
		w.afterFirstWrite = nil
		action()
	}
	return n, err
}

func TestContentAuditOriginalRoutesRequireLiveRootSession(t *testing.T) {
	user, identity, token, router := contentAuditManagementFixture(t)
	require.NoError(t, model.UpdateUserAccessToken(user.Id, "root-pat-original-denied"))
	for _, suffix := range []string{"/originals/0", "/images"} {
		path := "/api/content-audit/records/0123456789abcdef0123456789abcdef" + suffix
		for _, credential := range []string{"root-pat-original-denied", "sk-relay-denied", ""} {
			result := contentAuditManagementRequest(router, http.MethodGet, path, credential, "", nil)
			assert.Contains(t, []int{http.StatusForbidden, http.StatusUnauthorized}, result.Code)
		}
		for _, role := range []int{common.RoleAdminUser, common.RoleCommonUser} {
			require.NoError(t, model.DB.Model(user).Update("role", role).Error)
			require.NoError(t, model.PublishUserAuthCache(user.Id))
			result := contentAuditManagementRequest(router, http.MethodGet, path, token, "", nil)
			assert.Equal(t, http.StatusForbidden, result.Code)
		}
		require.NoError(t, model.DB.Model(user).Update("role", common.RoleRootUser).Error)
		require.NoError(t, model.PublishUserAuthCache(user.Id))
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Origin", "https://foreign.invalid")
		result := httptest.NewRecorder()
		router.ServeHTTP(result, request)
		assert.Equal(t, http.StatusForbidden, result.Code)
		require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Update("expires_at", time.Now().Unix()-1).Error)
		result = contentAuditManagementRequest(router, http.MethodGet, path, token, "", nil)
		assert.Contains(t, []int{http.StatusForbidden, http.StatusUnauthorized}, result.Code)
		require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Updates(map[string]any{"expires_at": time.Now().Unix() + 600, "status": model.UserSessionStatusRevoked}).Error)
		result = contentAuditManagementRequest(router, http.MethodGet, path, token, "", nil)
		assert.Contains(t, []int{http.StatusForbidden, http.StatusUnauthorized}, result.Code)
		require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Update("status", model.UserSessionStatusActive).Error)
	}
}

func TestContentAuditManagementRequiresLiveRootSession(t *testing.T) {
	user, identity, token, router := contentAuditManagementFixture(t)
	for _, path := range []string{"/api/content-audit/status", "/api/content-audit/records"} {
		response := contentAuditManagementRequest(router, http.MethodGet, path, token, "", nil)
		assert.Equal(t, http.StatusOK, response.Code, response.Body.String())
		assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
	}
	require.NoError(t, model.UpdateUserAccessToken(user.Id, "root-personal-access-token"))
	for _, opaque := range []string{"root-personal-access-token", "sk-relay-credential", ""} {
		response := contentAuditManagementRequest(router, http.MethodGet, "/api/content-audit/status", opaque, "", nil)
		assert.Contains(t, []int{http.StatusForbidden, http.StatusUnauthorized}, response.Code)
		assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
	}
	for _, role := range []int{common.RoleAdminUser, common.RoleCommonUser} {
		require.NoError(t, model.DB.Model(user).Update("role", role).Error)
		require.NoError(t, model.PublishUserAuthCache(user.Id))
		response := contentAuditManagementRequest(router, http.MethodGet, "/api/content-audit/status", token, "", nil)
		assert.Equal(t, http.StatusForbidden, response.Code)
	}
	require.NoError(t, model.DB.Model(user).Update("role", common.RoleRootUser).Error)
	require.NoError(t, model.PublishUserAuthCache(user.Id))
	request := httptest.NewRequest(http.MethodGet, "/api/content-audit/status", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Origin", "https://foreign.invalid")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	assert.Equal(t, http.StatusForbidden, response.Code)
	require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Update("expires_at", time.Now().Unix()-1).Error)
	response = contentAuditManagementRequest(router, http.MethodGet, "/api/content-audit/status", token, "", nil)
	assert.Equal(t, http.StatusUnauthorized, response.Code)
	require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Updates(map[string]any{"expires_at": time.Now().Unix() + 60, "status": model.UserSessionStatusRevoked}).Error)
	response = contentAuditManagementRequest(router, http.MethodGet, "/api/content-audit/records/0123456789abcdef0123456789abcdef/thumbnails/0", token, "", nil)
	assert.Equal(t, http.StatusUnauthorized, response.Code)
}

func TestContentAuditSettingsProofBindingReplayExpiryAndDurableAccess(t *testing.T) {
	user, identity, token, router := contentAuditManagementFixture(t)
	settings := service.ContentAuditSettingsUpdate{ExpectedVersion: 1, ContentAuditSettings: model.DefaultContentAuditSettings()}
	settings.RetentionDays = 8
	body, err := common.Marshal(settings)
	require.NoError(t, err)
	operation := service.VerificationOperation{Scope: service.VerificationScopeContentAuditSettings, Context: body}
	response := contentAuditManagementRequest(router, http.MethodPut, "/api/content-audit/settings", token, "", body)
	assert.Equal(t, http.StatusForbidden, response.Code)
	proof := issueSecurityEnrollmentProof(t, identity, operation, service.VerificationMethodPassword)
	changed := settings
	changed.RetentionDays = 9
	changedBody, err := common.Marshal(changed)
	require.NoError(t, err)
	response = contentAuditManagementRequest(router, http.MethodPut, "/api/content-audit/settings", token, proof, changedBody)
	assert.Equal(t, http.StatusForbidden, response.Code)
	assert.Contains(t, response.Body.String(), "SECURITY_PROOF_CONTEXT_MISMATCH")
	other, err := service.CreateLoginSession(user.Id, "password", "127.0.0.1", "other-browser")
	require.NoError(t, err)
	response = contentAuditManagementRequest(router, http.MethodPut, "/api/content-audit/settings", other.AccessToken, proof, body)
	assert.Equal(t, http.StatusForbidden, response.Code)
	response = contentAuditManagementRequest(router, http.MethodPut, "/api/content-audit/settings", token, proof, body)
	assert.Equal(t, http.StatusOK, response.Code, response.Body.String())
	state, err := model.GetContentAuditState(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 8, state.RetentionDays)
	response = contentAuditManagementRequest(router, http.MethodPut, "/api/content-audit/settings", token, proof, body)
	assert.Equal(t, http.StatusForbidden, response.Code)
	assert.Contains(t, response.Body.String(), "SECURITY_PROOF_CONSUMED")
	settings.ExpectedVersion = state.ConfigVersion
	body, err = common.Marshal(settings)
	require.NoError(t, err)
	operation.Context = body
	proof = issueSecurityEnrollmentProof(t, identity, operation, service.VerificationMethodPassword)
	require.NoError(t, model.DB.Model(&model.AuthFlow{}).Where("purpose = ?", model.AuthFlowPurposeSecurityProof).Update("expires_at", time.Now().Add(-time.Minute)).Error)
	response = contentAuditManagementRequest(router, http.MethodPut, "/api/content-audit/settings", token, proof, body)
	assert.Equal(t, http.StatusForbidden, response.Code)
	assert.Contains(t, response.Body.String(), "SECURITY_PROOF_EXPIRED")
	// A log-store outage denies content before even looking up the record and
	// prevents a protection change. The proof stays consumed after failure.
	const callback = "test:content_audit_log_failure"
	require.NoError(t, model.LOG_DB.Callback().Create().Before("gorm:create").Register(callback, func(tx *gorm.DB) { tx.AddError(errors.New("forced log-store failure")) }))
	t.Cleanup(func() { _ = model.LOG_DB.Callback().Create().Remove(callback) })
	proof = issueSecurityEnrollmentProof(t, identity, operation, service.VerificationMethodPassword)
	response = contentAuditManagementRequest(router, http.MethodPut, "/api/content-audit/settings", token, proof, body)
	assert.Equal(t, http.StatusServiceUnavailable, response.Code)
	unchanged, err := model.GetContentAuditState(context.Background())
	require.NoError(t, err)
	assert.Equal(t, state.ConfigVersion, unchanged.ConfigVersion)
	response = contentAuditManagementRequest(router, http.MethodGet, "/api/content-audit/records/0123456789abcdef0123456789abcdef", token, "", nil)
	assert.Equal(t, http.StatusServiceUnavailable, response.Code)
	assert.NotContains(t, response.Body.String(), "forced log-store failure")
	require.NoError(t, model.LOG_DB.Callback().Create().Remove(callback))
	response = contentAuditManagementRequest(router, http.MethodGet, "/api/content-audit/records/0123456789abcdef0123456789abcdef", token, "", nil)
	assert.Equal(t, http.StatusNotFound, response.Code)
	var events []model.AuditLog
	require.NoError(t, model.LOG_DB.Where("action = ?", "content_audit.read").Find(&events).Error)
	require.Len(t, events, 2)
	assert.Equal(t, common.RoleRootUser, events[0].ActorRole)
	assert.Equal(t, events[0].Other.RootInfo["operation_id"], events[1].Other.RootInfo["operation_id"])
	encoded, err := common.Marshal(events)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), token)
	assert.NotContains(t, string(encoded), proof)
	assert.Error(t, model.UpdateOptionsBulk(map[string]string{"content_audit.enabled": "true"}))
	assert.Error(t, model.UpdateOption("ContentAuditEnabled", "true"))
}

func TestContentAuditProofScopeMethodAndDeleteSelection(t *testing.T) {
	_, identity, token, router := contentAuditManagementFixture(t)
	input := service.ContentAuditSettingsUpdate{ExpectedVersion: 1, ContentAuditSettings: model.DefaultContentAuditSettings()}
	body, err := common.Marshal(input)
	require.NoError(t, err)
	operation := service.VerificationOperation{Scope: service.VerificationScopeContentAuditSettings, Context: body}
	const first = "0123456789abcdef0123456789abcdef"
	const second = "abcdef0123456789abcdef0123456789"
	deletion := service.VerificationOperation{Scope: service.VerificationScopeContentAuditDelete, Context: []byte(`{"ids":["` + second + `","` + first + `","` + second + `"]}`)}
	proof := issueSecurityEnrollmentProof(t, identity, deletion, service.VerificationMethodPassword)
	response := contentAuditManagementRequest(router, http.MethodPut, "/api/content-audit/settings", token, proof, body)
	assert.Equal(t, http.StatusForbidden, response.Code)
	assert.Contains(t, response.Body.String(), "SECURITY_PROOF_SCOPE_MISMATCH")
	wrongMethod := issueSecurityEnrollmentProof(t, identity, operation, service.VerificationMethodSession)
	response = contentAuditManagementRequest(router, http.MethodPut, "/api/content-audit/settings", token, wrongMethod, body)
	assert.Equal(t, http.StatusForbidden, response.Code)
	assert.Contains(t, response.Body.String(), "SECURITY_PROOF_METHOD_MISMATCH")
	response = contentAuditManagementRequest(router, http.MethodPost, "/api/content-audit/records/delete", token, proof, []byte(`{"ids":["`+first+`"]}`))
	assert.Equal(t, http.StatusForbidden, response.Code)
	assert.Contains(t, response.Body.String(), "SECURITY_PROOF_CONTEXT_MISMATCH")
	// Order and duplicates are semantically irrelevant, but the exact set is
	// bound to this session and the token is still consumed only once.
	response = contentAuditManagementRequest(router, http.MethodPost, "/api/content-audit/records/delete", token, proof, []byte(`{"ids":["`+first+`","`+second+`"]}`))
	assert.Equal(t, http.StatusAccepted, response.Code, response.Body.String())
	response = contentAuditManagementRequest(router, http.MethodDelete, "/api/content-audit/records/"+first, token, proof, nil)
	assert.Equal(t, http.StatusForbidden, response.Code)

	// Revocation must be read from the primary DB even when auth cache still
	// contains the formerly authorized root identity.
	require.NoError(t, model.DB.Model(&model.User{}).Where("id = ?", identity.UserID).Update("role", common.RoleAdminUser).Error)
	response = contentAuditManagementRequest(router, http.MethodGet, "/api/content-audit/status", token, "", nil)
	assert.Contains(t, []int{http.StatusForbidden, http.StatusUnauthorized}, response.Code)
}

func TestContentAuditResetMarksStoppedRecordsButLeavesLiveWriters(t *testing.T) {
	_, identity, token, router := contentAuditManagementFixture(t)
	ids := []string{
		"0123456789abcdef0123456789abcdef",
		"abcdef0123456789abcdef0123456789",
		"fedcba9876543210fedcba9876543210",
	}
	now := time.Now().Unix()
	records := []model.ContentAudit{
		{AuditID: ids[0], Attempt: "attempt-ready", Status: model.ContentAuditReady, WriterStopped: true, CreatedAt: now, ExpiresAt: now + 86400},
		{AuditID: ids[1], Attempt: "attempt-failed", Status: model.ContentAuditFailed, WriterStopped: true, CreatedAt: now, ExpiresAt: now + 86400},
		{AuditID: ids[2], Attempt: "attempt-pending", Status: model.ContentAuditPending, WriterStopped: false, CreatedAt: now, ExpiresAt: now + 86400},
	}
	require.NoError(t, model.DB.Create(&records).Error)
	operation := service.VerificationOperation{Scope: "content_audit.reset", Context: []byte(`{}`)}
	proof := issueSecurityEnrollmentProof(t, identity, operation, service.VerificationMethodPassword)
	response := contentAuditManagementRequest(router, http.MethodPost, "/api/content-audit/records/reset", token, proof, []byte(`{}`))
	assert.Equal(t, http.StatusAccepted, response.Code, response.Body.String())
	var saved []model.ContentAudit
	require.NoError(t, model.DB.Where("audit_id IN ?", ids).Find(&saved).Error)
	byID := make(map[string]model.ContentAudit, len(saved))
	for _, record := range saved {
		byID[record.AuditID] = record
	}
	assert.Equal(t, model.ContentAuditDeleting, byID[ids[0]].Status)
	assert.Equal(t, model.ContentAuditDeleting, byID[ids[1]].Status)
	assert.Equal(t, model.ContentAuditPending, byID[ids[2]].Status)
	assert.False(t, byID[ids[2]].WriterStopped)
}

func TestContentAuditHTTPDisclosureRequiresDurableResultAndLiveSession(t *testing.T) {
	_, identity, token, router := contentAuditManagementFixture(t)
	directory := t.TempDir()
	require.NoError(t, os.Chmod(directory, 0700))
	t.Setenv("CONTENT_AUDIT_STORAGE_DIR", directory)
	t.Setenv("CRYPTO_SECRET", "content-audit-http-fixture-stable-key")
	oldMaster := common.IsMasterNode
	common.IsMasterNode = false
	t.Cleanup(func() { common.IsMasterNode = oldMaster })
	// GORM callback tables are not safe to mutate while runtime queries run.
	// Install before Start; LIFO cleanup stops workers before removing hooks.
	var observedDeletion atomic.Bool
	var watchedAuditID atomic.Value
	watchedAuditID.Store("")
	maintained := make(chan struct{}, 1)
	const queryCallback = "test:original_held_delete_candidate"
	const updateCallback = "test:original_held_cleanup_completed"
	require.NoError(t, model.DB.Callback().Query().After("gorm:query").Register(queryCallback, func(tx *gorm.DB) {
		if records, ok := tx.Statement.Dest.(*[]model.ContentAudit); ok {
			for _, candidate := range *records {
				if candidate.AuditID == watchedAuditID.Load().(string) && candidate.Status == model.ContentAuditDeleting {
					observedDeletion.Store(true)
				}
			}
		}
	}))
	require.NoError(t, model.DB.Callback().Update().After("gorm:update").Register(updateCallback, func(tx *gorm.DB) {
		if state, ok := tx.Statement.Dest.(*model.ContentAuditStorageState); ok && state.LastCleanupAt > 0 && observedDeletion.Load() {
			select {
			case maintained <- struct{}{}:
			default:
			}
		}
	}))
	t.Cleanup(func() {
		_ = model.DB.Callback().Query().Remove(queryCallback)
		_ = model.DB.Callback().Update().Remove(updateCallback)
	})
	service.StartContentAudit()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		require.NoError(t, service.StopContentAudit(ctx))
	})
	initBody := []byte(`{"expected_version":1,"plaintext_acknowledged":false}`)
	proof := issueSecurityEnrollmentProof(t, identity, service.VerificationOperation{Scope: service.VerificationScopeContentAuditInitialize, Context: initBody}, service.VerificationMethodPassword)
	response := contentAuditManagementRequest(router, http.MethodPost, "/api/content-audit/initialize", token, proof, initBody)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	state, err := model.GetContentAuditState(context.Background())
	require.NoError(t, err)
	status, err := service.GetContentAuditStatus(context.Background())
	require.NoError(t, err)
	require.True(t, status.Ready, "disabled collection with initialized local storage is ready")
	require.False(t, status.State.Enabled)
	require.Greater(t, state.HealthyUntil, time.Now().Unix())
	settings := service.ContentAuditSettingsUpdate{ExpectedVersion: state.ConfigVersion, ContentAuditSettings: state.ContentAuditSettings}
	settings.Enabled = true
	body, err := common.Marshal(settings)
	require.NoError(t, err)
	proof = issueSecurityEnrollmentProof(t, identity, service.VerificationOperation{Scope: service.VerificationScopeContentAuditSettings, Context: body}, service.VerificationMethodPassword)
	response = contentAuditManagementRequest(router, http.MethodPut, "/api/content-audit/settings", token, proof, body)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())

	var picture bytes.Buffer
	require.NoError(t, png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 8, 4))))
	pngBytes := bytes.Clone(picture.Bytes())
	text := bytes.Repeat([]byte{'x'}, 300<<10)
	copy(text, []byte("Comment\x00"))
	var chunk [8]byte
	binary.BigEndian.PutUint32(chunk[:4], uint32(len(text)))
	copy(chunk[4:], "tEXt")
	checksum := crc32.NewIEEE()
	_, _ = checksum.Write(chunk[4:])
	_, _ = checksum.Write(text)
	var crc [4]byte
	binary.BigEndian.PutUint32(crc[:], checksum.Sum32())
	picture.Reset()
	_, _ = picture.Write(pngBytes[:len(pngBytes)-12])
	_, _ = picture.Write(chunk[:])
	_, _ = picture.Write(text)
	_, _ = picture.Write(crc[:])
	_, _ = picture.Write(pngBytes[len(pngBytes)-12:])
	wire, err := common.Marshal(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(picture.Bytes())}}})
	require.NoError(t, err)
	router.POST("/v1/images/generations", func(c *gin.Context) {
		storage, err := common.CreateBodyStorage([]byte(`{"prompt":"private audit prompt","password":"structured-credential"}`))
		require.NoError(t, err)
		defer common.CleanupBodyStorage(c)
		c.Set(common.KeyBodyStorage, storage)
		c.Set("id", identity.UserID)
		c.Set("username", "root-audit-fixture")
		c.Set("channel_id", 1)
		c.Set("original_model", "image-fixture")
		c.Set(common.RequestIdKey, "audit-http-relay")
		c.Next()
	}, service.CaptureContentAudit, func(c *gin.Context) { c.Data(http.StatusOK, "application/json", wire) })
	response = contentAuditManagementRequest(router, http.MethodPost, "/v1/images/generations", token, "", nil)
	assert.Equal(t, http.StatusOK, response.Code)
	assert.Equal(t, wire, response.Body.Bytes(), "capture cannot rewrite the client image payload")
	require.Eventually(t, func() bool {
		var count int64
		return model.DB.Model(&model.ContentAudit{}).Where("request_id = ? AND status = ?", "audit-http-relay", model.ContentAuditReady).Count(&count).Error == nil && count == 1
	}, 5*time.Second, 10*time.Millisecond, "owned snapshot must be persisted by the worker")
	var record model.ContentAudit
	require.NoError(t, model.DB.Where("request_id = ?", "audit-http-relay").First(&record).Error)
	path := "/api/content-audit/records/" + record.AuditID
	response = contentAuditManagementRequest(router, http.MethodGet, path, token, "", nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), "private audit prompt")
	assert.NotContains(t, response.Body.String(), "structured-credential")
	assert.NotContains(t, response.Body.String(), directory)
	assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
	response = contentAuditManagementRequest(router, http.MethodGet, path+"/thumbnails/0", token, "", nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, "image/jpeg", response.Header().Get("Content-Type"))
	assert.Equal(t, "nosniff", response.Header().Get("X-Content-Type-Options"))
	_, format, err := image.DecodeConfig(bytes.NewReader(response.Body.Bytes()))
	require.NoError(t, err)
	assert.Equal(t, "jpeg", format)
	response = contentAuditManagementRequest(router, http.MethodGet, path+"/originals/0", token, "", nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, picture.Bytes(), response.Body.Bytes())
	assert.Equal(t, "image/png", response.Header().Get("Content-Type"))
	assert.Equal(t, strconv.Itoa(picture.Len()), response.Header().Get("Content-Length"))
	assert.Contains(t, response.Header().Get("Content-Disposition"), "attachment;")
	assert.Contains(t, response.Header().Get("Cache-Control"), "no-store")
	assert.Equal(t, "nosniff", response.Header().Get("X-Content-Type-Options"))
	response = contentAuditManagementRequest(router, http.MethodGet, path+"/images?after=-1&limit=20", token, "", nil)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), `"original_status":"ready"`)

	const failure = "test:content_audit_http_result_failure"
	require.NoError(t, model.LOG_DB.Callback().Create().Before("gorm:create").Register(failure, func(tx *gorm.DB) {
		if event, ok := tx.Statement.Dest.(*model.AuditLog); ok && event.Other.RootInfo["phase"] == "result" {
			tx.AddError(errors.New("log result unavailable"))
		}
	}))
	for _, suffix := range []string{"", "/thumbnails/0", "/originals/0", "/images"} {
		response = contentAuditManagementRequest(router, http.MethodGet, path+suffix, token, "", nil)
		assert.Equal(t, http.StatusServiceUnavailable, response.Code)
		assert.NotContains(t, response.Body.String(), "private audit prompt")
		assert.NotContains(t, response.Body.String(), "log result unavailable")
	}
	require.NoError(t, model.LOG_DB.Callback().Create().Remove(failure))
	for _, interruption := range []string{"session-revoked", "record-expired", "client-cancelled"} {
		ctx, cancel := context.WithCancel(context.Background())
		request := httptest.NewRequest(http.MethodGet, path+"/originals/0", nil).WithContext(ctx)
		request.Header.Set("Authorization", "Bearer "+token)
		interrupted := &contentAuditInterruptingWriter{ResponseRecorder: httptest.NewRecorder()}
		interrupted.afterFirstWrite = func() {
			switch interruption {
			case "session-revoked":
				require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Update("status", model.UserSessionStatusRevoked).Error)
			case "record-expired":
				require.NoError(t, model.DB.Model(&record).Update("expires_at", time.Now().Unix()-1).Error)
			case "client-cancelled":
				cancel()
			}
		}
		router.ServeHTTP(interrupted, request)
		cancel()
		assert.Equal(t, http.StatusOK, interrupted.Code)
		require.Positive(t, interrupted.Body.Len())
		require.Less(t, interrupted.Body.Len(), picture.Len(), interruption)
		assert.Equal(t, picture.Bytes()[:interrupted.Body.Len()], interrupted.Body.Bytes(), "binary interruption must not append a JSON error")
		require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Update("status", model.UserSessionStatusActive).Error)
		require.NoError(t, model.DB.Model(&record).Update("expires_at", time.Now().Unix()+600).Error)
	}
	require.NoError(t, model.DB.Model(&record).Update("expires_at", time.Now().Unix()-1).Error)
	for _, suffix := range []string{"", "/thumbnails/0", "/originals/0", "/images"} {
		response = contentAuditManagementRequest(router, http.MethodGet, path+suffix, token, "", nil)
		assert.Equal(t, http.StatusGone, response.Code, "TTL must not wait for physical cleanup")
	}
	require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Update("status", model.UserSessionStatusRevoked).Error)
	response = contentAuditManagementRequest(router, http.MethodGet, path+"/thumbnails/0", token, "", nil)
	assert.Contains(t, []int{http.StatusUnauthorized, http.StatusForbidden}, response.Code)
	var events []model.AuditLog
	require.NoError(t, model.LOG_DB.Find(&events).Error)
	encoded, err := common.Marshal(events)
	require.NoError(t, err)
	for _, secret := range []string{token, proof, "private audit prompt", "structured-credential", base64.StdEncoding.EncodeToString(picture.Bytes())} {
		assert.NotContains(t, string(encoded), secret)
	}
	// A blocked network writer still owns its open original. Observe one actual
	// deletion-candidate maintenance pass while the first binary write is held.
	require.NoError(t, model.DB.Model(&model.UserSession{}).Where("sid = ?", identity.SessionID).Update("status", model.UserSessionStatusActive).Error)
	require.NoError(t, model.DB.Model(&record).Update("expires_at", time.Now().Unix()+600).Error)
	before, err := model.GetContentAuditState(context.Background())
	require.NoError(t, err)
	watchedAuditID.Store(record.AuditID)
	blocked, resume := context.WithCancel(context.Background())
	defer resume()
	entered, completed := make(chan struct{}), make(chan struct{})
	held := &contentAuditInterruptingWriter{ResponseRecorder: httptest.NewRecorder(), afterFirstWrite: func() { close(entered); <-blocked.Done() }}
	request := httptest.NewRequest(http.MethodGet, path+"/originals/0", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	go func() { router.ServeHTTP(held, request); close(completed) }()
	t.Cleanup(func() {
		resume()
		wait, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		select {
		case <-completed:
		case <-wait.Done():
			t.Error("original HTTP handler did not stop before runtime teardown")
		}
	})
	waitCtx, stopWait := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopWait()
	select {
	case <-entered:
	case <-waitCtx.Done():
		t.Fatal("original HTTP writer did not reach its first block")
	}
	require.NoError(t, service.RequestContentAuditDeletion(context.Background(), service.ContentAuditDeleteRequest{IDs: []string{record.AuditID}}))
	select {
	case <-maintained:
	case <-waitCtx.Done():
		t.Fatal("maintenance did not inspect the held deletion candidate")
	}
	_, err = model.GetContentAudit(context.Background(), record.AuditID)
	assert.NoError(t, err, "blocked binary response keeps physical original charge owned")
	during, err := model.GetContentAuditState(context.Background())
	require.NoError(t, err)
	assert.Equal(t, before.UsedBytes+before.ReservedBytes, during.UsedBytes+during.ReservedBytes)
	resume()
	select {
	case <-completed:
	case <-waitCtx.Done():
		t.Fatal("cancelled blocked writer did not return")
	}
	assert.Equal(t, picture.Bytes()[:held.Body.Len()], held.Body.Bytes())
	assert.Less(t, held.Body.Len(), picture.Len(), "deletion stops further binary blocks without JSON")
}
