package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/oauth"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/pquerna/otp/totp"
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
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.InviteCode{}, &model.InviteCodeUsage{}, &model.AuthFlow{}))
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

	_, _, err := findOrCreateOAuthUser(c, provider, oauthUser, nil, "", "")
	assert.ErrorIs(t, err, model.ErrInviteCodeRequired)

	generated, err := model.CreateInviteCodes(1, "oauth registration", 1, 1, 0)
	require.NoError(t, err)
	inviteCodeHash, err := model.HashInviteCode(generated[0].Code)
	require.NoError(t, err)
	user, _, err := findOrCreateOAuthUser(c, provider, oauthUser, nil, "", inviteCodeHash)
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

func TestPendingOAuthRegistrationConsumesFlowAndInviteAtomically(t *testing.T) {
	setupInviteRegistrationTest(t)
	provider := &authFlowTestOAuthProvider{}
	oauth.Register("invite-flow-test", provider)
	t.Cleanup(func() { oauth.Unregister("invite-flow-test") })
	oauthUser := &oauth.OAuthUser{
		ProviderUserID: "pending-oauth-user",
		Username:       "pendingoauth",
		DisplayName:    "Pending OAuth",
		Extra:          map[string]any{},
	}
	registrationToken, _, err := createPendingOAuthRegistration("invite-flow-test", oauthUser, "")
	require.NoError(t, err)

	var userCount int64
	require.NoError(t, model.DB.Model(&model.User{}).Count(&userCount).Error)
	assert.Zero(t, userCount)

	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	_, _, _, err = completePendingOAuthRegistration(c, registrationToken, "NAPI-AAAA-BBBB-CCCC-DDDD")
	assert.ErrorIs(t, err, model.ErrInviteCodeUnavailable)
	_, err = model.GetAuthFlow(registrationToken, model.AuthFlowMatch{
		Purpose:  model.AuthFlowPurposeOAuthRegistration,
		Provider: "invite-flow-test",
		Intent:   model.AuthFlowIntentLogin,
	})
	require.NoError(t, err, "a rejected invite must not consume the registration flow")
	require.NoError(t, model.DB.Model(&model.User{}).Count(&userCount).Error)
	assert.Zero(t, userCount)

	generated, err := model.CreateInviteCodes(1, "pending oauth registration", 1, 1, 0)
	require.NoError(t, err)
	user, _, providerName, err := completePendingOAuthRegistration(c, registrationToken, generated[0].Code)
	require.NoError(t, err)
	assert.Equal(t, "invite-flow-test", providerName)
	assert.Equal(t, "pendingoauth", user.Username)

	_, _, _, err = completePendingOAuthRegistration(c, registrationToken, generated[0].Code)
	assert.ErrorIs(t, err, model.ErrAuthFlowConsumed)
	var usage model.InviteCodeUsage
	require.NoError(t, model.DB.First(&usage).Error)
	assert.Equal(t, user.Id, usage.UserId)
	assert.Equal(t, "oauth:flow_", usage.RegistrationMethod)
}

// A pending invite registration no longer holds the provider access token, so
// a legacy GitHub login-name match found when it completes is declined unless
// the login verification confirms the account.
func TestCompleteOAuthRegistrationLegacyGitHubMatchRequiresLoginVerification(t *testing.T) {
	const declined = "This GitHub account cannot be linked to an existing account automatically, please sign in or register another way and then link GitHub in account settings"
	for _, test := range []struct {
		name       string
		withFactor bool
	}{
		{name: "without second factor declines"},
		{name: "second factor migrates after verification", withFactor: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			setupSecurityEnrollmentTest(t)
			previousRegister := common.RegisterEnabled
			common.RegisterEnabled = true
			t.Cleanup(func() { common.RegisterEnabled = previousRegister })
			const slug = "github-legacy-registration-test"
			provider := &legacyGitHubOAuthProvider{providerUserID: "900001", legacyID: "octocat-legacy", verifiedEmails: []string{"legacy-github@example.com"}}
			oauth.Register(slug, provider)
			t.Cleanup(func() { oauth.Unregister(slug) })
			registrationToken, _, err := createPendingOAuthRegistration(slug, &oauth.OAuthUser{
				ProviderUserID: "900001",
				Username:       "octocat-legacy",
				Extra:          map[string]any{"legacy_id": "octocat-legacy"},
			}, "")
			require.NoError(t, err)
			// The legacy row appears only after the callback found no account.
			existing := &model.User{Username: "legacy-github", Email: "legacy-github@example.com", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, Group: "default", AffCode: "legacy-github", AuthVersion: 1, GitHubId: "octocat-legacy"}
			require.NoError(t, model.DB.Create(existing).Error)
			factor := &model.TwoFA{UserId: existing.Id, Secret: "JBSWY3DPEHPK3PXP", IsEnabled: true}
			if test.withFactor {
				require.NoError(t, model.DB.Create(factor).Error)
			}

			body, err := common.Marshal(map[string]string{"registration_token": registrationToken, "invite_code": "NAPI-AAAA-BBBB-CCCC-DDDD"})
			require.NoError(t, err)
			response := securityEnrollmentRequest(http.MethodPost, "/api/oauth/registration", string(body), "", service.AuthIdentity{}, CompleteOAuthRegistration)
			var result securityEnrollmentResponse
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
			assert.Empty(t, response.Header().Values("Set-Cookie"))
			assert.Zero(t, provider.verifiedEmailCalls, "no access token is left to ask for verified emails")
			var reloaded model.User
			require.NoError(t, model.DB.First(&reloaded, existing.Id).Error)
			assert.Equal(t, "octocat-legacy", reloaded.GitHubId, "the binding waits for the verification")
			_, params := legacyGitHubBindingAudits(t)
			if !test.withFactor {
				require.False(t, result.Success, response.Body.String())
				assert.Equal(t, declined, result.Message)
				require.Len(t, params, 1)
				assert.JSONEq(t, `{"provider":"github","legacy_migration":true,"legacy_id":"octocat-legacy","provider_user_id":"900001","success":false,"reason":"no_matching_evidence"}`, params[0])
				return
			}
			require.True(t, result.Success, response.Body.String())
			assert.Empty(t, params)
			var challenge service.LoginChallenge
			require.NoError(t, common.Unmarshal(result.Data, &challenge))
			require.True(t, challenge.RequireVerification)

			code, err := totp.GenerateCode(factor.Secret, time.Now())
			require.NoError(t, err)
			body, err = common.Marshal(map[string]string{"flow_token": challenge.FlowToken, "code": code})
			require.NoError(t, err)
			response = securityEnrollmentRequest(http.MethodPost, "/api/user/login/verify", string(body), "", service.AuthIdentity{}, VerifyLogin)
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
			require.True(t, result.Success, response.Body.String())
			assert.NotEmpty(t, response.Header().Values("Set-Cookie"))
			require.NoError(t, model.DB.First(&reloaded, existing.Id).Error)
			assert.Equal(t, "900001", reloaded.GitHubId)
		})
	}
}

func TestPendingWeChatRegistrationDoesNotCreateUserBeforeInvite(t *testing.T) {
	setupInviteRegistrationTest(t)
	registrationToken, _, err := createPendingWeChatRegistration("wechat-pending-user")
	require.NoError(t, err)

	var userCount int64
	require.NoError(t, model.DB.Model(&model.User{}).Count(&userCount).Error)
	assert.Zero(t, userCount)

	generated, err := model.CreateInviteCodes(1, "wechat registration", 1, 1, 0)
	require.NoError(t, err)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	user, _, providerName, err := completePendingOAuthRegistration(c, registrationToken, generated[0].Code)
	require.NoError(t, err)
	assert.Equal(t, "wechat", providerName)
	assert.Equal(t, "wechat-pending-user", user.WeChatId)

	var usage model.InviteCodeUsage
	require.NoError(t, model.DB.First(&usage).Error)
	assert.Equal(t, user.Id, usage.UserId)
	assert.Equal(t, "wechat", usage.RegistrationMethod)
}
