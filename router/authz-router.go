package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"

	"github.com/gin-gonic/gin"
)

// registerAuthzRoutes mounts the authorization API under its own /authz
// namespace. Only root may read the permission schema used by the client
// permission editor because it controls per-user administrator grants.
func registerAuthzRoutes(apiRouter *gin.RouterGroup) {
	authzRoute := apiRouter.Group("/authz")
	authzRoute.Use(middleware.RootAuth())
	{
		authzRoute.GET("/catalog", controller.GetPermissionCatalog)
	}
}
