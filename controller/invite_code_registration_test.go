package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/oauth"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupInviteRegistrationTest(t *testing.T) {
	t.Helper()
	previousDB := model.DB
	previousType := common.MainDatabaseType()
	previousRegisterEnabled := common.RegisterEnabled
	previousPasswordRegisterEnabled := common.PasswordRegisterEnabled
	previousInviteRegistrationEnabled := common.InviteRegistrationEnabled
	previousEmailVerificationEnabled := common.EmailVerificationEnabled
	previousGenerateDefaultToken := constant.GenerateDefaultToken

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.InviteCode{}, &model.InviteCodeUsage{}))
	model.DB = db
	common.SetMainDatabaseType(common.DatabaseTypeSQLite)
	common.RegisterEnabled = true
	common.PasswordRegisterEnabled = true
	common.InviteRegistrationEnabled = true
	common.EmailVerificationEnabled = false
	constant.GenerateDefaultToken = false

	t.Cleanup(func() {
		model.DB = previousDB
		common.SetMainDatabaseType(previousType)
		common.RegisterEnabled = previousRegisterEnabled
		common.PasswordRegisterEnabled = previousPasswordRegisterEnabled
		common.InviteRegistrationEnabled = previousInviteRegistrationEnabled
		common.EmailVerificationEnabled = previousEmailVerificationEnabled
		constant.GenerateDefaultToken = previousGenerateDefaultToken
	})
}

func performPasswordRegistration(t *testing.T, body string) (int, bool, string) {
	t.Helper()
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/user/register", strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	Register(c)
	var response struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &response))
	return recorder.Code, response.Success, response.Message
}

func TestPasswordRegistrationRequiresAndAtomicallyConsumesInviteCode(t *testing.T) {
	setupInviteRegistrationTest(t)
	generated, err := model.CreateInviteCodes(1, "registration", 1, 1, 0)
	require.NoError(t, err)
	require.Len(t, generated, 1)

	_, success, message := performPasswordRegistration(t, `{"username":"withoutcode","password":"password123"}`)
	assert.False(t, success)
	assert.NotEmpty(t, message)

	validBody := `{"username":"inviteduser","password":"password123","invite_code":"` + generated[0].Code + `"}`
	_, success, message = performPasswordRegistration(t, validBody)
	assert.True(t, success, message)

	reusedBody := `{"username":"seconduser","password":"password123","invite_code":"` + generated[0].Code + `"}`
	_, success, message = performPasswordRegistration(t, reusedBody)
	assert.False(t, success)
	assert.NotEmpty(t, message)

	var users []model.User
	require.NoError(t, model.DB.Find(&users).Error)
	require.Len(t, users, 1)
	assert.Equal(t, "inviteduser", users[0].Username)
	var inviteCode model.InviteCode
	require.NoError(t, model.DB.First(&inviteCode, generated[0].InviteCode.Id).Error)
	assert.Equal(t, 1, inviteCode.UsedCount)
	var usage model.InviteCodeUsage
	require.NoError(t, model.DB.First(&usage).Error)
	assert.Equal(t, users[0].Id, usage.UserId)
	assert.Equal(t, "password", usage.RegistrationMethod)
}

func TestOAuthNewAccountRequiresAndConsumesInviteCode(t *testing.T) {
	setupInviteRegistrationTest(t)
	provider := &authFlowTestOAuthProvider{}
	oauthUser := &oauth.OAuthUser{
		ProviderUserID: "oauth-invited-user",
		Username:       "oauthinvited",
		DisplayName:    "OAuth Invited",
	}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())

	_, err := findOrCreateOAuthUser(c, provider, oauthUser, "", "")
	assert.ErrorIs(t, err, model.ErrInviteCodeRequired)

	generated, err := model.CreateInviteCodes(1, "oauth registration", 1, 1, 0)
	require.NoError(t, err)
	inviteCodeHash, err := model.HashInviteCode(generated[0].Code)
	require.NoError(t, err)
	user, err := findOrCreateOAuthUser(c, provider, oauthUser, "", inviteCodeHash)
	require.NoError(t, err)
	assert.Equal(t, "oauthinvited", user.Username)

	var inviteCode model.InviteCode
	require.NoError(t, model.DB.First(&inviteCode, generated[0].InviteCode.Id).Error)
	assert.Equal(t, 1, inviteCode.UsedCount)
	var usage model.InviteCodeUsage
	require.NoError(t, model.DB.First(&usage).Error)
	assert.Equal(t, user.Id, usage.UserId)
	assert.Equal(t, "oauth:flow_", usage.RegistrationMethod)
}
