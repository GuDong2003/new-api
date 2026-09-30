package authz

const ResourceTask = "task"

var TaskRead = Permission{Resource: ResourceTask, Action: ActionRead}

func init() {
	RegisterResource(ResourceDefinition{
		Resource: ResourceTask,
		LabelKey: "Task Logs",
		Actions: []ActionDefinition{{
			Action:         ActionRead,
			LabelKey:       "View other accounts' task logs",
			DescriptionKey: "View task records from user and admin roles. Root records are always excluded.",
		}},
	})
}
