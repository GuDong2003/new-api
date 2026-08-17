package authz

const (
	ResourceUser = "user"

	UserActionRead            = ActionRead
	UserActionCreate          = "create"
	UserActionProfileWrite    = "profile_write"
	UserActionStatusWrite     = "status_write"
	UserActionQuotaWrite      = "quota_write"
	UserActionSecurityWrite   = "security_write"
	UserActionRoleWrite       = "role_write"
	UserActionDelete          = "delete"
	UserActionPermissionWrite = "permission_write"
)

var (
	UserRead            = Permission{Resource: ResourceUser, Action: UserActionRead}
	UserCreate          = Permission{Resource: ResourceUser, Action: UserActionCreate}
	UserProfileWrite    = Permission{Resource: ResourceUser, Action: UserActionProfileWrite}
	UserStatusWrite     = Permission{Resource: ResourceUser, Action: UserActionStatusWrite}
	UserQuotaWrite      = Permission{Resource: ResourceUser, Action: UserActionQuotaWrite}
	UserSecurityWrite   = Permission{Resource: ResourceUser, Action: UserActionSecurityWrite}
	UserRoleWrite       = Permission{Resource: ResourceUser, Action: UserActionRoleWrite}
	UserDelete          = Permission{Resource: ResourceUser, Action: UserActionDelete}
	UserPermissionWrite = Permission{Resource: ResourceUser, Action: UserActionPermissionWrite}
)

func init() {
	RegisterResource(ResourceDefinition{
		Resource: ResourceUser,
		LabelKey: "User Management",
		Actions: []ActionDefinition{
			{
				Action:         UserActionRead,
				LabelKey:       "View users",
				DescriptionKey: "View users you are allowed to manage.",
				DefaultRoles:   []string{BuiltInRoleAdmin},
			},
			{
				Action:         UserActionCreate,
				LabelKey:       "Create users",
				DescriptionKey: "Create users below your permission level.",
				DefaultRoles:   []string{BuiltInRoleAdmin},
			},
			{
				Action:         UserActionProfileWrite,
				LabelKey:       "Edit user profiles",
				DescriptionKey: "Edit usernames, display names, groups, and remarks.",
				DefaultRoles:   []string{BuiltInRoleAdmin},
			},
			{
				Action:         UserActionStatusWrite,
				LabelKey:       "Manage user status",
				DescriptionKey: "Enable or disable users below your permission level.",
				DefaultRoles:   []string{BuiltInRoleAdmin},
			},
			{
				Action:         UserActionQuotaWrite,
				LabelKey:       "Adjust user quota",
				DescriptionKey: "Adjust quota for users below your permission level.",
				DefaultRoles:   []string{BuiltInRoleAdmin},
			},
			{
				Action:         UserActionSecurityWrite,
				LabelKey:       "Manage user security",
				DescriptionKey: "Reset passwords, two-factor authentication, Passkeys, and bindings.",
				DefaultRoles:   []string{BuiltInRoleAdmin},
			},
			{
				Action:         UserActionRoleWrite,
				LabelKey:       "Manage user roles",
				DescriptionKey: "Promote or demote users.",
				DefaultRoles:   []string{BuiltInRoleAdmin},
			},
			{
				Action:         UserActionDelete,
				LabelKey:       "Delete users",
				DescriptionKey: "Delete users below your permission level.",
				DefaultRoles:   []string{BuiltInRoleAdmin},
			},
			{
				Action:         UserActionPermissionWrite,
				LabelKey:       "Assign user permissions",
				DescriptionKey: "Adjust per-user administrator permissions.",
			},
		},
	})
}
