package controller

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service/authz"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupManageUserTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousRedisEnabled := common.RedisEnabled
	previousMainDatabaseType, previousLogDatabaseType := common.MainDatabaseType(), common.LogDatabaseType()
	common.RedisEnabled = false
	common.SetDatabaseTypes(common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)

	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", strings.ReplaceAll(t.Name(), "/", "_"))
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	require.NoError(t, err)
	model.DB, model.LOG_DB = db, db
	require.NoError(t, db.AutoMigrate(
		&model.User{}, &model.UserSession{}, &model.Log{}, &model.CasbinRule{}, &model.AuthzRole{},
	))

	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.RedisEnabled = previousRedisEnabled
		common.SetDatabaseTypes(previousMainDatabaseType, previousLogDatabaseType)
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
	})
	return db
}

func performManageUserRequest(t *testing.T, body string) *httptest.ResponseRecorder {
	return performManageUserAs(t, 9999, common.RoleRootUser, body)
}

func performManageUserAs(t *testing.T, actorID int, actorRole int, body string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/user/manage", strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Set("id", actorID)
	c.Set("role", actorRole)
	c.Set("username", "root-operator")
	ManageUser(c)
	return recorder
}

func performGetManagedUserRequest(t *testing.T, actorID int, actorRole int, targetID int) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/user/%d", targetID), nil)
	c.Params = gin.Params{{Key: "id", Value: fmt.Sprintf("%d", targetID)}}
	c.Set("id", actorID)
	c.Set("role", actorRole)
	GetUser(c)
	return recorder
}

func performUpdateManagedUserRequest(t *testing.T, actorID int, actorRole int, body string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPut, "/api/user/", strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Set("id", actorID)
	c.Set("role", actorRole)
	c.Set("username", "self-admin")
	UpdateUser(c)
	return recorder
}

func initManageUserAuthz(t *testing.T, db *gorm.DB) {
	t.Helper()
	previousMaster := common.IsMasterNode
	common.IsMasterNode = true
	require.NoError(t, authz.Init(db))
	t.Cleanup(func() { common.IsMasterNode = previousMaster })
}

func TestManagedUserSelfAccessUpdatesProfileFieldsOnly(t *testing.T) {
	db := setupManageUserTestDB(t)
	initManageUserAuthz(t, db)
	user := model.User{
		Username: "self-admin", Password: "existing-password-hash", DisplayName: "Old Name",
		Role: common.RoleAdminUser, Status: common.UserStatusEnabled, Group: "default", Remark: "root-owned note", Email: "admin@example.com",
	}
	require.NoError(t, db.Create(&user).Error)

	getRecorder := performGetManagedUserRequest(t, user.Id, user.Role, user.Id)
	assert.Equal(t, http.StatusOK, getRecorder.Code)
	assert.Contains(t, getRecorder.Body.String(), `"success":true`)

	updateRecorder := performUpdateManagedUserRequest(
		t, user.Id, user.Role,
		fmt.Sprintf(`{"id":%d,"username":"renamed-admin","display_name":"New Name","group":"vip","remark":"changed"}`, user.Id),
	)
	assert.Equal(t, http.StatusOK, updateRecorder.Code)
	assert.Contains(t, updateRecorder.Body.String(), `"success":true`)

	var updated model.User
	require.NoError(t, db.First(&updated, user.Id).Error)
	assert.Equal(t, "renamed-admin", updated.Username)
	assert.Equal(t, "New Name", updated.DisplayName)
	assert.Equal(t, "existing-password-hash", updated.Password)
	assert.Equal(t, common.RoleAdminUser, updated.Role)
	assert.Equal(t, common.UserStatusEnabled, updated.Status)
	assert.Equal(t, "vip", updated.Group)
	assert.Equal(t, "changed", updated.Remark)
	assert.Equal(t, "admin@example.com", updated.Email)
}

func TestManagedUserPeerAccessRemainsDenied(t *testing.T) {
	db := setupManageUserTestDB(t)
	initManageUserAuthz(t, db)
	target := model.User{
		Username: "peer-admin", Password: "existing-password-hash", DisplayName: "Peer Name",
		Role: common.RoleAdminUser, Status: common.UserStatusEnabled, Group: "default",
	}
	require.NoError(t, db.Create(&target).Error)

	getRecorder := performGetManagedUserRequest(t, target.Id+100, common.RoleAdminUser, target.Id)
	assert.Contains(t, getRecorder.Body.String(), `"success":false`)

	updateRecorder := performUpdateManagedUserRequest(
		t, target.Id+100, common.RoleAdminUser,
		fmt.Sprintf(`{"id":%d,"username":"peer-admin","display_name":"Changed Name"}`, target.Id),
	)
	assert.Contains(t, updateRecorder.Body.String(), `"success":false`)

	var unchanged model.User
	require.NoError(t, db.First(&unchanged, target.Id).Error)
	assert.Equal(t, "Peer Name", unchanged.DisplayName)
}

func TestManagedUserSelfStatusAndQuotaActionsAreAllowed(t *testing.T) {
	db := setupManageUserTestDB(t)
	initManageUserAuthz(t, db)
	user := model.User{
		Username: "self-actions", Password: "existing-password-hash", DisplayName: "Self Actions",
		Role: common.RoleAdminUser, Status: common.UserStatusEnabled, Group: "default", Quota: 100,
	}
	require.NoError(t, db.Create(&user).Error)

	recorder := performManageUserAs(t, user.Id, user.Role, fmt.Sprintf(`{"id":%d,"action":"disable"}`, user.Id))
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	recorder = performManageUserAs(t, user.Id, user.Role, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":"add","value":50}`, user.Id))
	assert.Contains(t, recorder.Body.String(), `"success":true`)

	var updated model.User
	require.NoError(t, db.First(&updated, user.Id).Error)
	assert.Equal(t, common.UserStatusDisabled, updated.Status)
	assert.Equal(t, 150, updated.Quota)
}

func TestManagedAvatarTargetAllowsSelfButRejectsPeer(t *testing.T) {
	db := setupManageUserTestDB(t)
	initManageUserAuthz(t, db)
	target := model.User{
		Username: "avatar-admin", Password: "existing-password-hash",
		Role: common.RoleAdminUser, Status: common.UserStatusEnabled, Group: "default",
	}
	require.NoError(t, db.Create(&target).Error)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Params = gin.Params{{Key: "id", Value: fmt.Sprintf("%d", target.Id)}}
	c.Set("id", target.Id)
	c.Set("role", common.RoleAdminUser)
	userID, ok := managedAvatarTarget(c)
	assert.True(t, ok)
	assert.Equal(t, target.Id, userID)

	peerRecorder := httptest.NewRecorder()
	peerContext, _ := gin.CreateTestContext(peerRecorder)
	peerContext.Params = gin.Params{{Key: "id", Value: fmt.Sprintf("%d", target.Id)}}
	peerContext.Set("id", target.Id+100)
	peerContext.Set("role", common.RoleAdminUser)
	_, ok = managedAvatarTarget(peerContext)
	assert.False(t, ok)
}

func TestManageUserDisableAdvancesAuthVersionOnceAndRevokesSession(t *testing.T) {
	db := setupManageUserTestDB(t)
	now := time.Now().Unix()
	user := model.User{
		Username: "managed-disable-user", Password: "password", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1,
	}
	require.NoError(t, db.Create(&user).Error)
	require.NoError(t, db.Create(&model.UserSession{
		SID: "managed-disable-session", UserID: user.Id, Version: 1, UserAuthVersion: 1,
		Status: model.UserSessionStatusActive, RefreshHash: "refresh-hash", LoginMethod: "password",
		LastActiveAt: now, ExpiresAt: now + 3600,
	}).Error)

	recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"disable"}`, user.Id))
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"success":true`)

	var updated model.User
	require.NoError(t, db.First(&updated, user.Id).Error)
	assert.Equal(t, common.UserStatusDisabled, updated.Status)
	assert.EqualValues(t, 2, updated.AuthVersion)
	var session model.UserSession
	require.NoError(t, db.First(&session, "sid = ?", "managed-disable-session").Error)
	assert.Equal(t, model.UserSessionStatusRevoked, session.Status)
}

func TestManageUserDemoteAdvancesAuthVersionAndRevokesSessionsOnce(t *testing.T) {
	db := setupManageUserTestDB(t)
	previousMaster := common.IsMasterNode
	common.IsMasterNode = false
	t.Cleanup(func() { common.IsMasterNode = previousMaster })
	require.NoError(t, authz.Init(db))

	now := time.Now().Unix()
	user := model.User{
		Username: "managed-demote-user", Password: "password", Role: common.RoleAdminUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1,
	}
	require.NoError(t, db.Create(&user).Error)
	for _, sid := range []string{"managed-demote-session-one", "managed-demote-session-two"} {
		require.NoError(t, db.Create(&model.UserSession{
			SID: sid, UserID: user.Id, Version: 1, UserAuthVersion: 1,
			Status: model.UserSessionStatusActive, RefreshHash: "refresh-" + sid, LoginMethod: "password",
			LastActiveAt: now, ExpiresAt: now + 3600,
		}).Error)
	}

	sessionUpdateCount := 0
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:count_demote_session_updates", func(tx *gorm.DB) {
		if tx.Statement != nil && tx.Statement.Table == "user_sessions" {
			sessionUpdateCount++
		}
	}))

	recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"demote"}`, user.Id))
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"success":true`)

	var updated model.User
	require.NoError(t, db.First(&updated, user.Id).Error)
	assert.Equal(t, common.RoleCommonUser, updated.Role)
	assert.EqualValues(t, 2, updated.AuthVersion)
	var sessions []model.UserSession
	require.NoError(t, db.Where("user_id = ?", user.Id).Order("sid asc").Find(&sessions).Error)
	require.Len(t, sessions, 2)
	for _, session := range sessions {
		assert.Equal(t, model.UserSessionStatusRevoked, session.Status)
		assert.Equal(t, "admin_demote", session.RevokedReason)
	}
	assert.Equal(t, 1, sessionUpdateCount)
}

func TestManageUserDeleteReturnsImmediatelyAndUnknownActionFails(t *testing.T) {
	db := setupManageUserTestDB(t)
	deleted := model.User{
		Username: "managed-delete-user", Password: "password", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, AffCode: "delete-aff",
	}
	require.NoError(t, db.Create(&deleted).Error)

	recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"delete"}`, deleted.Id))
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	var deletedCount int64
	require.NoError(t, db.Unscoped().Model(&model.User{}).Where("id = ? AND deleted_at IS NOT NULL", deleted.Id).Count(&deletedCount).Error)
	assert.EqualValues(t, 1, deletedCount)

	unchanged := model.User{
		Username: "managed-unknown-user", Password: "password", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, AffCode: "unknown-aff",
	}
	require.NoError(t, db.Create(&unchanged).Error)
	recorder = performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"unknown"}`, unchanged.Id))
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	require.NoError(t, db.First(&unchanged, unchanged.Id).Error)
	assert.EqualValues(t, 1, unchanged.AuthVersion)
	assert.Equal(t, common.UserStatusEnabled, unchanged.Status)
}
