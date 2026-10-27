package i18n

// Message keys of i18n/locales/*.yaml, for text the backend translates itself:
// errors returned to AI clients, emails and notifications. Web console messages
// are not listed here; the web console translates them (see common.Message).

// Errors returned to AI clients
const (
	MsgDatabaseError          = "common.database_error"
	MsgAuthUserBanned         = "auth.user_banned"
	MsgTokenGetInfoFailed     = "token.get_info_failed"
	MsgTokenInvalid           = "token.invalid"
	MsgTokenNotProvided       = "token.not_provided"
	MsgTokenStatusUnavailable = "token.status_unavailable"

	MsgAuthClientIPUnresolved     = "auth.client_ip_unresolved"
	MsgAuthTokenIPNotAllowed      = "auth.token_ip_not_allowed"
	MsgAuthTokenGroupForbidden    = "auth.token_group_forbidden"
	MsgAuthTokenGroupDeprecated   = "auth.token_group_deprecated"
	MsgAuthChannelSelectForbidden = "auth.channel_select_forbidden"

	MsgRateLimitReached      = "rate_limit.reached"
	MsgRateLimitTotalReached = "rate_limit.total_reached"

	MsgDistributorInvalidRequest               = "distributor.invalid_request"
	MsgDistributorInvalidChannelId             = "distributor.invalid_channel_id"
	MsgDistributorChannelDisabled              = "distributor.channel_disabled"
	MsgDistributorTokenNoModelAccess           = "distributor.token_no_model_access"
	MsgDistributorTokenModelForbidden          = "distributor.token_model_forbidden"
	MsgDistributorModelNameRequired            = "distributor.model_name_required"
	MsgDistributorInvalidPlayground            = "distributor.invalid_playground_request"
	MsgDistributorGroupAccessDenied            = "distributor.group_access_denied"
	MsgDistributorGetChannelFailed             = "distributor.get_channel_failed"
	MsgDistributorNoAvailableChannel           = "distributor.no_available_channel"
	MsgDistributorNoAvailableChannelTaskPlugin = "distributor.no_available_channel_task_plugin"
	MsgDistributorInvalidParseModel            = "distributor.invalid_request_parse_model"

	MsgQuotaUserInsufficient             = "quota.user_insufficient"
	MsgQuotaPreConsumeInsufficient       = "quota.pre_consume_insufficient"
	MsgQuotaSubscriptionInsufficient     = "quota.subscription_insufficient"
	MsgRelayModelPriceNotConfigured      = "relay.model_price_not_configured"
	MsgRelayModelPriceNotConfiguredAdmin = "relay.model_price_not_configured_admin"
	MsgRelayTaskUsagePriceUnsupported    = "relay.task_usage_price_unsupported"
	MsgRelaySharedTaskPriceNeedsOverride = "relay.shared_task_price_needs_override"
	MsgRelayTaskChannelDisabled          = "relay.task_channel_disabled"
	MsgRelayGroupSaturated               = "relay.group_saturated"
	MsgRelayGroupUpstreamSaturated       = "relay.group_upstream_saturated"
	MsgRelayRetryGetChannelFailed        = "relay.retry_get_channel_failed"
	MsgRelayRetryNoAvailableChannel      = "relay.retry_no_available_channel"
	MsgRelayAccessTokenUnsupported       = "relay.access_token_unsupported"
)

// Emails and the name of the token created at registration, in the
// recipient's language
const (
	MsgUserDefaultTokenName = "user.default_token_name"

	MsgEmailVerificationSubject  = "email.verification.subject"
	MsgEmailVerificationGreeting = "email.verification.greeting"
	MsgEmailVerificationCode     = "email.verification.code"
	MsgEmailVerificationValidity = "email.verification.validity"

	MsgEmailPasswordResetSubject      = "email.password_reset.subject"
	MsgEmailPasswordResetGreeting     = "email.password_reset.greeting"
	MsgEmailPasswordResetLink         = "email.password_reset.link"
	MsgEmailPasswordResetLinkFallback = "email.password_reset.link_fallback"
	MsgEmailPasswordResetValidity     = "email.password_reset.validity"

	MsgEmailBindingSubject     = "email.binding.subject"
	MsgEmailBindingNewIntro    = "email.binding.new_intro"
	MsgEmailBindingOldIntro    = "email.binding.old_intro"
	MsgEmailBindingCode        = "email.binding.code"
	MsgEmailBindingNewValidity = "email.binding.new_validity"
	MsgEmailBindingOldValidity = "email.binding.old_validity"

	MsgEmailSecurityNoticeSubject = "email.security_notice.subject"
	MsgEmailSecurityNoticeChanged = "email.security_notice.changed"
	MsgEmailSecurityNoticeAdvice  = "email.security_notice.advice"

	MsgSecurityEventPasswordUpdated      = "email.security_event.password_updated"
	MsgSecurityEventEmailChangeRequested = "email.security_event.email_change_requested"
	MsgSecurityEventEmailChanged         = "email.security_event.email_changed"
	MsgSecurityEventEmailConfirmed       = "email.security_event.email_confirmed"
	MsgSecurityEventLoginLinked          = "email.security_event.login_linked"
	MsgSecurityEventLoginUnlinked        = "email.security_event.login_unlinked"
	MsgSecurityEventWeChatLinked         = "email.security_event.wechat_linked"
)

// Low-quota notices, in the recipient's saved language
const (
	MsgNotifyQuotaLowTitle             = "notify.quota_low_title"
	MsgNotifySubscriptionQuotaLowTitle = "notify.subscription_quota_low_title"
	MsgNotifyQuotaLowBark              = "notify.quota_low_bark"
	MsgNotifyQuotaLowGotify            = "notify.quota_low_gotify"
	MsgNotifyQuotaLowEmail             = "notify.quota_low_email"
)

// Channel notices sent to administrators who receive them and to model update
// watchers
const (
	MsgChannelNotifyDisabledSubject = "channel.notify_disabled_subject"
	MsgChannelNotifyDisabledContent = "channel.notify_disabled_content"
	MsgChannelNotifyEnabledSubject  = "channel.notify_enabled_subject"
	MsgChannelNotifyEnabledContent  = "channel.notify_enabled_content"
	MsgChannelTestCompletedSubject  = "channel.test_completed_subject"
	MsgChannelTestCompletedContent  = "channel.test_completed_content"
	MsgChannelResponseTimeExceeded  = "channel.response_time_exceeded"

	MsgChannelUpstreamUpdateNotifySubject   = "channel.upstream_update_notify_subject"
	MsgChannelUpstreamUpdateSummary         = "channel.upstream_update_summary"
	MsgChannelUpstreamUpdateChangedChannels = "channel.upstream_update_changed_channels"
	MsgChannelUpstreamUpdateMoreChannels    = "channel.upstream_update_more_channels"
	MsgChannelUpstreamUpdateAddedModels     = "channel.upstream_update_added_models"
	MsgChannelUpstreamUpdateRemovedModels   = "channel.upstream_update_removed_models"
	MsgChannelUpstreamUpdateFailedChannels  = "channel.upstream_update_failed_channels"
	MsgChannelUpstreamUpdateMoreOmitted     = "channel.upstream_update_more_omitted"
)

// Messages retained by local gateway features and account-security emails.
const (
	MsgInvalidParams                       = "common.invalid_params"
	MsgAuthInsufficientPrivilege           = "auth.insufficient_privilege"
	MsgRedemptionMaxUsesInvalid            = "redemption.max_uses_invalid"
	MsgRedemptionSharedCodeInvalid         = "redemption.shared_code_invalid"
	MsgRedemptionSharedMaxUsesInvalid      = "redemption.shared_max_uses_invalid"
	MsgRedemptionUsedUp                    = "redemption.used_up"
	MsgInviteCodeRequired                  = "invite_code.required"
	MsgInviteCodeUnavailable               = "invite_code.unavailable"
	MsgInviteCodeNameTooLong               = "invite_code.name_too_long"
	MsgInviteCodeCountInvalid              = "invite_code.count_invalid"
	MsgInviteCodeCustomCountInvalid        = "invite_code.custom_count_invalid"
	MsgInviteCodeFormatInvalid             = "invite_code.format_invalid"
	MsgInviteCodeMaxUsesInvalid            = "invite_code.max_uses_invalid"
	MsgInviteCodeExpireTimeInvalid         = "invite_code.expire_time_invalid"
	MsgInviteCodeExists                    = "invite_code.exists"
	MsgInviteCodeCreateFailed              = "invite_code.create_failed"
	MsgInviteCodeUpdateInvalid             = "invite_code.update_invalid"
	MsgInviteCodeDeleteUsed                = "invite_code.delete_used"
	MsgInviteCodeDeleteFailed              = "invite_code.delete_failed"
	MsgUserRegisterDisabled                = "user.register_disabled"
	MsgUserEmailAlreadyTaken               = "user.email_already_taken"
	MsgUserInputInvalid                    = "user.input_invalid"
	MsgUserNoPermissionHigherLevel         = "user.no_permission_higher_level"
	MsgRateLimitSiteReached                = "rate_limit.site_reached"
	MsgRateLimitSiteTotalReached           = "rate_limit.site_total_reached"
	MsgOAuthStateInvalid                   = "oauth.state_invalid"
	MsgOAuthUserDeleted                    = "oauth.user_deleted"
	MsgOAuthBindSuccess                    = "oauth.bind_success"
	MsgOAuthNotAutoLinked                  = "oauth.not_auto_linked"
	MsgEmailBindingNewAddress              = "email.binding.new_address"
	MsgEmailBindingCurrentAddress          = "email.binding.current_address"
	MsgAccountSecuritySubject              = "email.account_security.subject"
	MsgAccountSecurityBody                 = "email.account_security.body"
	MsgAccountSecurityPasswordUpdated      = "email.account_security.password_updated"
	MsgAccountSecurityEmailChangeRequested = "email.account_security.email_change_requested"
	MsgAccountSecurityEmailChanged         = "email.account_security.email_changed"
	MsgAccountSecurityEmailConfirmed       = "email.account_security.email_confirmed"
	MsgAccountSecurityLoginLinked          = "email.account_security.login_linked"
	MsgAccountSecurityLoginUnlinked        = "email.account_security.login_unlinked"
	MsgAccountSecurityWeChatLinked         = "email.account_security.wechat_linked"
)
