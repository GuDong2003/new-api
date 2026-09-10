package middleware

import (
	"net/http"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

// ContentAuditSessionAuth must follow RootAuth. Unlike RootAuth alone it rejects
// PATs and revalidates the live dashboard session. It adds neither cookie-only
// auth nor URL credentials, including for binary thumbnail responses.
func ContentAuditSessionAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		identity, ok := GetSessionAuthIdentity(c)
		if !ok || c.GetBool("use_access_token") {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "CONTENT_AUDIT_SESSION_REQUIRED", "message": "A live root dashboard session is required."})
			return
		}
		if err := model.ValidateContentAuditSession(c.Request.Context(), identity); err != nil {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "CONTENT_AUDIT_SESSION_REQUIRED", "message": "A live root dashboard session is required."})
			return
		}
		// Bearer auth is not ambient browser authority. Nevertheless reject an
		// explicitly foreign/malformed Origin rather than relaxing management
		// CORS to make authenticated thumbnails work.
		if c.GetHeader("Origin") != "" || c.GetHeader("Referer") != "" {
			origin, ok := requestBrowserOrigin(c.Request)
			if !ok || !isAllowedSessionOrigin(c.Request, origin) {
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "AUTH_ORIGIN_FORBIDDEN", "message": "Request origin is not allowed."})
				return
			}
		} else if c.GetHeader("Sec-Fetch-Site") == "cross-site" {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"success": false, "code": "AUTH_ORIGIN_FORBIDDEN", "message": "Request origin is not allowed."})
			return
		}
		c.Next()
	}
}

func ContentAuditCapture() gin.HandlerFunc { return service.CaptureContentAudit }
