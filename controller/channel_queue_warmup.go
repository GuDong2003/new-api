package controller

import (
	"context"
	"errors"

	"github.com/QuantumNous/new-api/model"
)

// QueueWarmupResult is the outcome of one internal queue warm-up request. It
// is intentionally separate from consumption logs and is used only by the
// queue warmer's retry and circuit-breaker classifier.
type QueueWarmupResult struct {
	StatusCode int
	IsTimeout  bool
	Err        error
	Message    string
}

// PerformChannelQueueWarmup reuses the channel-test relay path, but does not
// write a billable consume log. The warmer owns timeout, retry, and breaker
// policy; this function only performs one request and reports its outcome.
func PerformChannelQueueWarmup(ctx context.Context, channel *model.Channel, testModel string, endpointType string, message string, maxTokens *uint, isStream bool) QueueWarmupResult {
	testUserID, err := resolveChannelTestUserID(nil)
	if err != nil {
		return QueueWarmupResult{Err: err, Message: sanitizeWarmupMessage(err.Error())}
	}
	result := testChannelWithOptions(ctx, channel, testUserID, testModel, endpointType, isStream, channelTestOptions{
		message:        message,
		skipConsumeLog: true,
		maxTokens:      maxTokens,
	})

	statusCode := 0
	messageText := ""
	if result.localErr == nil && result.newAPIError == nil && result.context != nil && result.context.Writer != nil {
		statusCode = result.context.Writer.Status()
	}
	if result.newAPIError != nil {
		statusCode = result.newAPIError.StatusCode
		messageText = sanitizeWarmupMessage(result.newAPIError.Error())
	}
	if result.localErr != nil && messageText == "" {
		messageText = sanitizeWarmupMessage(result.localErr.Error())
	}
	if result.localErr == nil && result.newAPIError == nil && statusCode == 0 {
		statusCode = 200
	}
	requestErr := result.localErr
	if requestErr == nil && result.newAPIError != nil {
		requestErr = result.newAPIError
	}

	requestContext := ctx
	if requestContext == nil {
		requestContext = context.Background()
	}
	timeout := errors.Is(requestContext.Err(), context.DeadlineExceeded) || errors.Is(requestContext.Err(), context.Canceled)
	return QueueWarmupResult{
		StatusCode: statusCode,
		IsTimeout:  timeout,
		Err:        requestErr,
		Message:    messageText,
	}
}
