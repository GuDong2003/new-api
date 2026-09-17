package controller

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestDecideRelayRetryAfterResponseWritten(t *testing.T) {
	originalRanges := operation_setting.AutomaticRetryStatusCodeRanges
	t.Cleanup(func() {
		operation_setting.AutomaticRetryStatusCodeRanges = originalRanges
	})
	operation_setting.AutomaticRetryStatusCodeRanges = []operation_setting.StatusCodeRange{
		{Start: http.StatusInternalServerError, End: http.StatusInternalServerError},
	}

	retryableError := types.NewErrorWithStatusCode(
		errors.New("upstream server error"),
		types.ErrorCodeBadResponseStatusCode,
		http.StatusInternalServerError,
	)

	writtenContext, _ := gin.CreateTestContext(httptest.NewRecorder())
	writtenContext.Writer.Header().Set("Content-Type", "text/event-stream")
	_, err := writtenContext.Writer.WriteString("data: partial response\n\n")
	require.NoError(t, err)
	require.True(t, writtenContext.Writer.Written())
	decision := decideRelayRetry(writtenContext, retryableError, 1)
	require.Equal(t, "stop", decision.Action)
	require.Equal(t, "response_written", decision.Reason)

	unwrittenContext, _ := gin.CreateTestContext(httptest.NewRecorder())
	require.False(t, unwrittenContext.Writer.Written())
	require.Equal(t, "retry", decideRelayRetry(unwrittenContext, retryableError, 1).Action)
}
