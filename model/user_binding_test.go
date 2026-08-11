package model

import "testing"

func TestResolveBindingColumnAcceptsCanonicalAndFieldAliases(t *testing.T) {
	tests := []struct {
		input    string
		column   string
		provider string
	}{
		{input: "email", column: "email", provider: "email"},
		{input: "github", column: "github_id", provider: "github"},
		{input: "github_id", column: "github_id", provider: "github"},
		{input: "discord", column: "discord_id", provider: "discord"},
		{input: "discord_id", column: "discord_id", provider: "discord"},
		{input: "oidc", column: "oidc_id", provider: "oidc"},
		{input: "oidc_id", column: "oidc_id", provider: "oidc"},
		{input: "wechat", column: "wechat_id", provider: "wechat"},
		{input: "wechat_id", column: "wechat_id", provider: "wechat"},
		{input: "telegram", column: "telegram_id", provider: ExternalIdentityProviderTelegram},
		{input: "telegram_id", column: "telegram_id", provider: ExternalIdentityProviderTelegram},
		{input: "linuxdo", column: "linux_do_id", provider: "linuxdo"},
		{input: "linux_do_id", column: "linux_do_id", provider: "linuxdo"},
		{input: " LINUX_DO_ID ", column: "linux_do_id", provider: "linuxdo"},
	}

	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			column, provider, ok := resolveBindingColumn(test.input)
			if !ok {
				t.Fatalf("resolveBindingColumn(%q) unexpectedly rejected a supported binding", test.input)
			}
			if column != test.column || provider != test.provider {
				t.Fatalf(
					"resolveBindingColumn(%q) = (%q, %q), want (%q, %q)",
					test.input,
					column,
					provider,
					test.column,
					test.provider,
				)
			}
		})
	}
}

func TestResolveBindingColumnRejectsUnknownFields(t *testing.T) {
	for _, input := range []string{"", "password", "role", "github_id; DROP TABLE users"} {
		t.Run(input, func(t *testing.T) {
			if column, provider, ok := resolveBindingColumn(input); ok || column != "" || provider != "" {
				t.Fatalf(
					"resolveBindingColumn(%q) = (%q, %q, %t), want rejection",
					input,
					column,
					provider,
					ok,
				)
			}
		})
	}
}
