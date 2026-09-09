package model

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetSelfUserByIdIncludesAvatarURL(t *testing.T) {
	truncateTables(t)

	user := User{
		Username:  "profile-avatar-user",
		Password:  "password",
		AvatarURL: "/api/avatar/profile-avatar-user",
	}
	require.NoError(t, DB.Create(&user).Error)

	profile, err := GetSelfUserById(user.Id)
	require.NoError(t, err)
	assert.Equal(t, user.AvatarURL, profile.AvatarURL)
}
