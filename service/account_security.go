package service

import (
	"html"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/oauth"
	"github.com/QuantumNous/new-api/setting/system_setting"
)

func UnbindAccountOAuth(identity AuthIdentity, providerID int) error {
	enabled := model.AccountLoginMethods{
		Password: common.PasswordLoginEnabled,
		Passkey:  system_setting.PasskeySettingsSnapshot().Enabled,
		WeChat:   common.WeChatAuthEnabled,
	}
	for _, provider := range oauth.GetAllProviders() {
		if !provider.IsEnabled() {
			continue
		}
		if custom, ok := provider.(*oauth.GenericOAuthProvider); ok {
			enabled.CustomProviderIDs = append(enabled.CustomProviderIDs, custom.GetProviderId())
		} else {
			enabled.OAuthColumns = append(enabled.OAuthColumns, provider.ProviderUserIDColumn())
		}
	}
	return model.UnbindUserOAuthForSession(identity, providerID, enabled)
}

// NotifyAccountSecurityChange never includes credentials or tokens. The caller
// records delivery failure independently from the already-committed change.
// The event is the message key naming the change, written in the owner's lang.
func NotifyAccountSecurityChange(lang, email, event string, eventArgs ...map[string]any) error {
	if email == "" {
		return nil
	}
	subject := i18n.Translate(lang, i18n.MsgAccountSecuritySubject, map[string]any{"SystemName": common.SystemName})
	change := i18n.Translate(lang, event, eventArgs...)
	content := i18n.Translate(lang, i18n.MsgAccountSecurityBody, map[string]any{"Event": html.EscapeString(change)})
	return common.SendEmail(subject, email, content)
}
