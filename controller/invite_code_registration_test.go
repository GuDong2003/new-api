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
	previousRedisEnabled := common.RedisEnabled

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
	// RedisEnabled defaults to true, and no Redis client exists in this test.
	common.RedisEnabled = false

	t.Cleanup(func() {
		model.DB = previousDB
		common.SetMainDatabaseType(previousType)
		common.RegisterEnabled = previousRegisterEnabled
		common.PasswordRegisterEnabled = previousPasswordRegisterEnabled
		common.InviteRegistrationEnabled = previousInviteRegistrationEnabled
		common.EmailVerificationEnabled = previousEmailVerificationEnabled
		constant.GenerateDefaultToken = previousGenerateDefaultToken
		common.RedisEnabled = previousRedisEnabled
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
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/oauth/registration", nil)
	registrationToken, _, err := createPendingOAuthRegistration(c, "invite-flow-test", oauthUser, "")
	require.NoError(t, err)

	var userCount int64
	require.NoError(t, model.DB.Model(&model.User{}).Count(&userCount).Error)
	assert.Zero(t, userCount)

	for _, cookie := range recorder.Result().Cookies() {
		c.Request.AddCookie(cookie)
	}
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
			registrationResponse := httptest.NewRecorder()
			registrationContext, _ := gin.CreateTestContext(registrationResponse)
			registrationToken, _, err := createPendingOAuthRegistration(registrationContext, slug, &oauth.OAuthUser{
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
			response := securityEnrollmentRequest(http.MethodPost, "/api/oauth/registration", string(body), "", service.AuthIdentity{}, func(c *gin.Context) {
				for _, cookie := range registrationResponse.Result().Cookies() {
					c.Request.AddCookie(cookie)
				}
				CompleteOAuthRegistration(c)
			})
			var result securityEnrollmentResponse
			require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
			assertNoLoginSessionCookie(t, response)
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
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/oauth/registration", nil)
	registrationToken, _, err := createPendingWeChatRegistration(c, "wechat-pending-user")
	require.NoError(t, err)

	var userCount int64
	require.NoError(t, model.DB.Model(&model.User{}).Count(&userCount).Error)
	assert.Zero(t, userCount)

	generated, err := model.CreateInviteCodes(1, "wechat registration", 1, 1, 0)
	require.NoError(t, err)
	for _, cookie := range recorder.Result().Cookies() {
		c.Request.AddCookie(cookie)
	}
	user, _, providerName, err := completePendingOAuthRegistration(c, registrationToken, generated[0].Code)
	require.NoError(t, err)
	assert.Equal(t, "wechat", providerName)
	assert.Equal(t, "wechat-pending-user", user.WeChatId)

	var usage model.InviteCodeUsage
	require.NoError(t, model.DB.First(&usage).Error)
	assert.Equal(t, user.Id, usage.UserId)
	assert.Equal(t, "wechat", usage.RegistrationMethod)
}

func TestOAuthPendingRegistrationBrowserBinding(t *testing.T) {
	for _, providerName := range []string{"oauth", "wechat"} {
		for _, mode := range []string{"same browser", "missing cookie", "wrong cookie", "expired", "legacy unbound flow", "replay"} {
			t.Run(providerName+"/"+mode, func(t *testing.T) {
				setupSecurityEnrollmentTest(t)
				require.NoError(t, model.DB.AutoMigrate(&model.InviteCode{}, &model.InviteCodeUsage{}))
				oldRegister, oldInvite := common.RegisterEnabled, common.InviteRegistrationEnabled
				common.RegisterEnabled, common.InviteRegistrationEnabled = true, true
				t.Cleanup(func() { common.RegisterEnabled, common.InviteRegistrationEnabled = oldRegister, oldInvite })
				const slug = "pending-browser-test"
				oauth.Register(slug, &authFlowTestOAuthProvider{})
				t.Cleanup(func() { oauth.Unregister(slug) })
				var token string
				var cookie *http.Cookie
				if providerName == "oauth" {
					state, loginCookie := startOAuthLoginTest(t, slug)
					response := securityEnrollmentRequest(http.MethodGet, "/api/oauth/"+slug+"?state="+state+"&code=provider-code", "", "", service.AuthIdentity{}, func(c *gin.Context) {
						c.Params = gin.Params{{Key: "provider", Value: slug}}
						c.Request.AddCookie(loginCookie)
						HandleOAuth(c)
					})
					var pending struct {
						Success bool `json:"success"`
						Data    struct {
							RequireInviteCode bool   `json:"require_invite_code"`
							RegistrationToken string `json:"registration_token"`
						} `json:"data"`
					}
					require.NoError(t, common.Unmarshal(response.Body.Bytes(), &pending))
					require.True(t, pending.Success)
					require.True(t, pending.Data.RequireInviteCode)
					token = pending.Data.RegistrationToken
					for _, written := range response.Result().Cookies() {
						if written.Name == loginCookie.Name {
							assert.Less(t, written.MaxAge, 0)
						} else if written.MaxAge > 0 {
							cookie = written
						}
					}
				} else {
					response := httptest.NewRecorder()
					c, _ := gin.CreateTestContext(response)
					var err error
					token, _, err = createPendingWeChatRegistration(c, "browser-bound-wechat")
					require.NoError(t, err)
					cookies := response.Result().Cookies()
					require.Equal(t, 1, len(cookies))
					cookie = cookies[0]
				}
				require.NotNil(t, cookie)
				flow, err := model.GetAuthFlow(token, model.AuthFlowMatch{Purpose: model.AuthFlowPurposeOAuthRegistration})
				require.NoError(t, err)
				if providerName == "oauth" {
					assert.Equal(t, slug, flow.Provider, "use the registry slug, not the provider display name")
				}
				switch mode {
				case "missing cookie":
					cookie = nil
				case "wrong cookie":
					cookie.Value = strings.Repeat("x", len(cookie.Value))
				case "expired":
					require.NoError(t, model.DB.Model(flow).Update("expires_at", time.Now().Add(-time.Minute)).Error)
				case "legacy unbound flow":
					var payload oauthRegistrationPayload
					require.NoError(t, common.UnmarshalJsonStr(flow.Payload, &payload))
					payload.BrowserBindingHash = ""
					encoded, err := common.Marshal(payload)
					require.NoError(t, err)
					require.NoError(t, model.DB.Model(flow).Update("payload", string(encoded)).Error)
				}
				generated, err := model.CreateInviteCodes(1, "browser registration", 1, 1, 0)
				require.NoError(t, err)
				body, err := common.Marshal(completeOAuthRegistrationRequest{RegistrationToken: token, InviteCode: generated[0].Code})
				require.NoError(t, err)
				complete := func() *httptest.ResponseRecorder {
					return securityEnrollmentRequest(http.MethodPost, "/api/oauth/registration", string(body), "", service.AuthIdentity{}, func(c *gin.Context) {
						if cookie != nil {
							c.Request.AddCookie(cookie)
						}
						CompleteOAuthRegistration(c)
					})
				}
				response := complete()
				var result securityEnrollmentResponse
				require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
				var users int64
				require.NoError(t, model.DB.Model(&model.User{}).Count(&users).Error)
				var invite model.InviteCode
				require.NoError(t, model.DB.First(&invite, generated[0].InviteCode.Id).Error)
				if mode == "same browser" || mode == "replay" {
					require.True(t, result.Success)
					assert.EqualValues(t, 2, users)
					assert.Equal(t, 1, invite.UsedCount)
					cleared := false
					for _, written := range response.Result().Cookies() {
						if written.Name == cookie.Name {
							cleared = written.MaxAge < 0 && written.Value == ""
						}
					}
					assert.True(t, cleared)
					if mode == "same browser" {
						return
					}
					response = complete()
					require.NoError(t, common.Unmarshal(response.Body.Bytes(), &result))
				} else {
					assert.EqualValues(t, 1, users, "a rejected browser cannot create an account")
					assert.Zero(t, invite.UsedCount, "a rejected browser cannot consume an invitation")
				}
				assert.False(t, result.Success)
				assertNoLoginSessionCookie(t, response)
				if mode == "missing cookie" || mode == "wrong cookie" {
					_, err = model.GetAuthFlow(token, model.AuthFlowMatch{Purpose: model.AuthFlowPurposeOAuthRegistration})
					assert.NoError(t, err)
				}
			})
		}
	}
}
