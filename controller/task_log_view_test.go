package controller

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/dto"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestTaskLogDTOSeparatesUserAdminAndRootDetails(t *testing.T) {
	task := &model.Task{
		TaskID:   "task_public",
		Platform: "document-parser",
		PrivateData: model.TaskPrivateData{
			Key:            "channel-secret-canary",
			UpstreamTaskID: "upstream-private",
			NodeName:       "node-a",
			Execution: &model.TaskExecutionSnapshot{
				RequestID:   "request-public",
				RequestPath: "/v1/documents",
				TaskPlugin: &model.TaskPluginSnapshot{
					Key:     "document-parser",
					Name:    "Document Parser",
					Version: "1.2.3",
					Author: &model.TaskPluginAuthorSnapshot{
						Name: "Community Author",
						URL:  "https://plugins.example/author",
					},
					APIVersion: 1,
					Generation: 42,
				},
			},
		},
	}

	userView := tasksToDto([]*model.Task{task}, false, common.RoleCommonUser)[0]
	assert.Nil(t, userView.AdminInfo)
	assert.Nil(t, userView.RootInfo)

	adminView := tasksToDto([]*model.Task{task}, false, common.RoleAdminUser)[0]
	require.NotNil(t, adminView.AdminInfo)
	require.NotNil(t, adminView.AdminInfo.TaskPlugin)
	assert.Equal(t, "document-parser", adminView.AdminInfo.TaskPlugin.Key)
	assert.Equal(t, "Document Parser", adminView.AdminInfo.TaskPlugin.Name)
	assert.Equal(t, "1.2.3", adminView.AdminInfo.TaskPlugin.Version)
	require.NotNil(t, adminView.AdminInfo.TaskPlugin.Author)
	assert.Equal(t, "Community Author", adminView.AdminInfo.TaskPlugin.Author.Name)
	assert.Equal(t, "https://plugins.example/author", adminView.AdminInfo.TaskPlugin.Author.URL)
	assert.Equal(t, "request-public", adminView.AdminInfo.RequestID)
	assert.Equal(t, "/v1/documents", adminView.AdminInfo.RequestPath)
	assert.Nil(t, adminView.RootInfo)

	rootView := tasksToDto([]*model.Task{task}, false, common.RoleRootUser)[0]
	require.NotNil(t, rootView.AdminInfo)
	require.NotNil(t, rootView.RootInfo)
	require.NotNil(t, rootView.RootInfo.TaskPlugin)
	assert.Equal(t, 1, rootView.RootInfo.TaskPlugin.APIVersion)
	assert.Equal(t, uint64(42), rootView.RootInfo.TaskPlugin.Generation)
	assert.Equal(t, "upstream-private", rootView.RootInfo.UpstreamTaskID)
	assert.Equal(t, "node-a", rootView.RootInfo.NodeName)

	adminJSON, err := common.Marshal(adminView)
	require.NoError(t, err)
	assert.NotContains(t, string(adminJSON), "channel-secret-canary")
	assert.NotContains(t, string(adminJSON), "upstream-private")

	rootJSON, err := common.Marshal(rootView)
	require.NoError(t, err)
	assert.NotContains(t, string(rootJSON), "channel-secret-canary")
	assert.Contains(t, string(rootJSON), "upstream-private")
}

// The existing dialect harness uses isolated table prefixes for task queries.
// Authorization has fixed table names, so its fixture uses a separate SQLite
// database rather than touching an external database's policy tables.
func setupTaskLogPermissionTest(t *testing.T) {
	t.Helper()
	db, dialect := openTaskDialectDatabase(t, &model.User{}, &model.Task{})
	policyDB, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, policyDB.AutoMigrate(&model.CasbinRule{}, &model.AuthzRole{}))
	policySQL, err := policyDB.DB()
	require.NoError(t, err)
	policySQL.SetMaxOpenConns(1)
	t.Cleanup(func() { require.NoError(t, policySQL.Close()) })
	oldDB, oldRedis, oldMaster := model.DB, common.RedisEnabled, common.IsMasterNode
	oldType := common.MainDatabaseType()
	model.DB, common.RedisEnabled, common.IsMasterNode = db, false, true
	common.SetMainDatabaseType(dialect)
	t.Cleanup(func() {
		model.DB, common.RedisEnabled, common.IsMasterNode = oldDB, oldRedis, oldMaster
		common.SetMainDatabaseType(oldType)
	})
	require.NoError(t, authz.Init(policyDB))
	for i, role := range []int{common.RoleCommonUser, common.RoleAdminUser, common.RoleAdminUser, common.RoleRootUser} {
		userID := i + 1
		require.NoError(t, db.Create(&model.User{
			Id: userID, Username: fmt.Sprintf("task-viewer-%d", userID), AffCode: fmt.Sprintf("task-aff-%d", userID),
			Role: role, Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1,
		}).Error)
		require.NoError(t, db.Create(&model.Task{
			UserId: userID, TaskID: fmt.Sprintf("task_owner_%d", userID), Platform: "document",
			Status: model.TaskStatusQueued, SubmitTime: 10,
		}).Error)
	}
}

func taskLogRequest(userID, role int, path string) (*gin.Context, *httptest.ResponseRecorder) {
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, path, nil)
	c.Set("id", userID)
	c.Set("role", role)
	return c, recorder
}

func TestTaskLogPermissionDefaultsGrantAndRevocation(t *testing.T) {
	setupTaskLogPermissionTest(t)
	permission := authz.Permission{Resource: "task", Action: "read"}
	assert.False(t, authz.Capabilities(2, common.RoleAdminUser)["task"]["read"])
	assert.True(t, authz.Capabilities(4, common.RoleRootUser)["task"]["read"])
	for _, allowed := range []bool{false, true, false} {
		require.NoError(t, authz.SetUserPermissions(2, authz.PermissionsMap{"task": {"read": allowed}}))
		c, recorder := taskLogRequest(2, common.RoleAdminUser, "/api/task")
		middleware.RequirePermission(permission)(c)
		if allowed {
			assert.False(t, c.IsAborted())
		} else {
			assert.Equal(t, http.StatusForbidden, recorder.Code)
			assert.True(t, c.IsAborted())
		}
	}
	assert.False(t, authz.Can(1, common.RoleCommonUser, permission))
}

func TestTaskLogListFiltersOwnersBeforePaginationAndCount(t *testing.T) {
	setupTaskLogPermissionTest(t)
	for _, tc := range []struct {
		name, query         string
		viewer, role, total int
		ids                 []string
	}{
		{"admin first page", "?page_size=1", 2, common.RoleAdminUser, 3, []string{"task_owner_3"}},
		{"admin second page", "?page_size=1&p=2", 2, common.RoleAdminUser, 3, []string{"task_owner_2"}},
		{"admin root filter", "?task_id=task_owner_4", 2, common.RoleAdminUser, 0, []string{}},
		{"root all owners", "?page_size=10", 4, common.RoleRootUser, 4, []string{"task_owner_4", "task_owner_3", "task_owner_2", "task_owner_1"}},
		{"user self", "/self", 1, common.RoleCommonUser, 1, []string{"task_owner_1"}},
		{"admin self", "/self", 2, common.RoleAdminUser, 1, []string{"task_owner_2"}},
		{"root self", "/self", 4, common.RoleRootUser, 1, []string{"task_owner_4"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, recorder := taskLogRequest(tc.viewer, tc.role, "/api/task"+tc.query)
			if tc.query == "/self" {
				GetUserTask(c)
			} else {
				GetAllTask(c)
			}
			var response struct {
				Success bool `json:"success"`
				Data    struct {
					Total int           `json:"total"`
					Items []dto.TaskDto `json:"items"`
				} `json:"data"`
			}
			require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
			require.True(t, response.Success)
			assert.Equal(t, tc.total, response.Data.Total)
			ids := make([]string, 0, len(response.Data.Items))
			for _, task := range response.Data.Items {
				ids = append(ids, task.TaskID)
			}
			assert.Equal(t, tc.ids, ids)
		})
	}
}

func TestTaskLogArtifactRequestsEnforcePermissionAndOwnerRole(t *testing.T) {
	setupTaskLogPermissionTest(t)
	for _, tc := range []struct {
		name                         string
		viewer, role, owner, tokenID int
		grant, accessToken, allowed  bool
	}{
		{"user own", 1, common.RoleCommonUser, 1, 0, false, false, true},
		{"user other", 1, common.RoleCommonUser, 2, 0, false, false, false},
		{"admin own without grant", 2, common.RoleAdminUser, 2, 0, false, false, true},
		{"admin denied other user", 2, common.RoleAdminUser, 1, 0, false, false, false},
		{"admin denied other admin", 2, common.RoleAdminUser, 3, 0, false, false, false},
		{"admin granted user", 2, common.RoleAdminUser, 1, 0, true, false, true},
		{"admin granted peer", 2, common.RoleAdminUser, 3, 0, true, false, true},
		{"admin granted root denied", 2, common.RoleAdminUser, 4, 0, true, false, false},
		{"admin PAT denied", 2, common.RoleAdminUser, 1, 0, false, true, false},
		{"admin PAT granted peer", 2, common.RoleAdminUser, 3, 0, true, true, true},
		{"admin PAT root denied", 2, common.RoleAdminUser, 4, 0, true, true, false},
		{"root other", 4, common.RoleRootUser, 2, 0, false, false, true},
		{"root own", 4, common.RoleRootUser, 4, 0, false, false, true},
		{"API token own", 2, common.RoleAdminUser, 2, 10, true, false, true},
		{"API token remains owner bound", 2, common.RoleAdminUser, 3, 10, true, false, false},
		{"root API token remains owner bound", 4, common.RoleRootUser, 3, 10, false, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.NoError(t, authz.SetUserPermissions(2, authz.PermissionsMap{"task": {"read": tc.grant}}))
			taskID := fmt.Sprintf("task_owner_%d", tc.owner)
			c, recorder := taskLogRequest(tc.viewer, tc.role, "/api/task/"+taskID+"/artifacts")
			c.Set("use_access_token", tc.accessToken)
			c.Set("access_token_legacy", tc.accessToken)
			c.Set("token_id", tc.tokenID)
			c.Params = gin.Params{{Key: "task_id", Value: taskID}}
			_, exists, err := getTaskForArtifactRequest(c, taskID)
			require.NoError(t, err)
			assert.Equal(t, tc.allowed, exists)
			GetDashboardTaskArtifacts(c)
			if tc.allowed {
				assert.Equal(t, http.StatusOK, recorder.Code)
			} else {
				assert.Equal(t, http.StatusNotFound, recorder.Code)
				assert.NotContains(t, recorder.Body.String(), "artifacts\":")
			}
		})
	}
	t.Run("own task wins a historical duplicate identifier", func(t *testing.T) {
		require.NoError(t, authz.SetUserPermissions(2, authz.PermissionsMap{"task": {"read": true}}))
		require.NoError(t, model.DB.Create(&model.Task{
			UserId: 2, TaskID: "task_owner_4", Platform: "document", Status: model.TaskStatusQueued,
		}).Error)
		c, _ := taskLogRequest(2, common.RoleAdminUser, "/api/task/task_owner_4/artifacts")
		task, exists, err := getTaskForArtifactRequest(c, "task_owner_4")
		require.NoError(t, err)
		require.True(t, exists)
		assert.Equal(t, 2, task.UserId)
	})
}

func TestScopedPATTaskArtifactsRequireTheOwnerOrTaskReadScope(t *testing.T) {
	setupTaskLogPermissionTest(t)
	require.NoError(t, authz.SetUserPermissions(2, authz.PermissionsMap{"task": {"read": true}}))
	for _, test := range []struct {
		viewer, role, owner int
		scopes              []string
		allowed             bool
	}{
		{2, common.RoleAdminUser, 2, []string{"usage:read"}, true},
		{2, common.RoleAdminUser, 3, []string{"usage:read"}, false},
		{4, common.RoleRootUser, 3, []string{"usage:read"}, false},
		{2, common.RoleAdminUser, 3, []string{"usage:read", "task:read"}, true},
	} {
		taskID := fmt.Sprintf("task_owner_%d", test.owner)
		c, _ := taskLogRequest(test.viewer, test.role, "/api/task/"+taskID+"/artifacts")
		c.Set("use_access_token", true)
		c.Set("access_token_scopes", test.scopes)
		_, exists, err := getTaskForArtifactRequest(c, taskID)
		require.NoError(t, err)
		assert.Equal(t, test.allowed, exists, "owner=%d viewer=%d scopes=%v", test.owner, test.viewer, test.scopes)
	}
}

func TestTaskLogDTODoesNotInventHistoricalPluginProvenance(t *testing.T) {
	task := &model.Task{
		TaskID:   "task_without_snapshot",
		Platform: "document-parser",
	}

	adminView := tasksToDto([]*model.Task{task}, false, common.RoleAdminUser)[0]

	assert.Nil(t, adminView.AdminInfo)
	assert.Nil(t, adminView.RootInfo)
}

func TestTaskLogDTOReplacesLegacyVideoURLWithAvailabilityFlag(t *testing.T) {
	task := &model.Task{
		TaskID:     "task_legacy_video",
		Platform:   "jimeng",
		Action:     constant.TaskActionTextToVideo,
		Status:     model.TaskStatusSuccess,
		FailReason: "https://private-upstream.invalid/video.mp4?signature=secret",
	}

	view := tasksToDto([]*model.Task{task}, false, common.RoleCommonUser)[0]
	assert.True(t, view.LegacyVideoAvailable)
	assert.Empty(t, view.ResultURL)
	assert.Empty(t, view.FailReason)
	encoded, err := common.Marshal(view)
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), "private-upstream.invalid")
	assert.NotContains(t, string(encoded), "result_url")
	assert.Contains(t, string(encoded), "legacy_video_available")
}

func TestTaskLogDTOKeepsFailureReasonAndDoesNotMarkPluginTaskLegacy(t *testing.T) {
	failed := &model.Task{
		TaskID:     "task_failed",
		Platform:   "jimeng",
		Action:     constant.TaskActionTextToVideo,
		Status:     model.TaskStatusFailure,
		FailReason: "provider rejected the request",
	}
	failedView := tasksToDto([]*model.Task{failed}, false, common.RoleCommonUser)[0]
	assert.Equal(t, "provider rejected the request", failedView.FailReason)
	assert.False(t, failedView.LegacyVideoAvailable)

	pluginTask := &model.Task{
		TaskID:     "task_plugin_video",
		Platform:   "community-video",
		Action:     constant.TaskActionTextToVideo,
		Status:     model.TaskStatusSuccess,
		FailReason: "https://stale-upstream.invalid/plugin-video.mp4",
		PrivateData: model.TaskPrivateData{
			ResultURL: "https://private-upstream.invalid/plugin-video.mp4",
			Execution: &model.TaskExecutionSnapshot{
				TaskPlugin: &model.TaskPluginSnapshot{Key: "community-video"},
			},
		},
	}
	pluginView := tasksToDto([]*model.Task{pluginTask}, false, common.RoleCommonUser)[0]
	assert.False(t, pluginView.LegacyVideoAvailable)
	assert.Empty(t, pluginView.ResultURL)
	assert.Empty(t, pluginView.FailReason)
}
