package channel

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/google/uuid"
)

const (
	codeBuddyProductVersion = "5.3.8"
	codeBuddyCLIUserAgent   = "2.115.0"

	// codeBuddySystemTemplate is the WorkBuddy official system prompt preamble
	// used as the client-side marker. Upstreams like FreeModel
	// (https://work.freemodel.dev) reject requests whose first system message
	// does not carry the "This conversation is powered by <model>" marker, so
	// the relay must inject it verbatim (with %s = upstream model name).
	codeBuddySystemTemplate = "This conversation is powered by %s\r\n\r\nYour main goal is to follow the USER's instructions at each message, denoted by the <user_query> tag."
)

// ApplyCodeBuddyRequestProfile applies the WorkBuddy client request profile:
// it injects the official system-prompt marker, forces streaming and usage
// reporting, and normalizes temperature/reasoning the way the official client
// does. The marker is required by non-official upstreams that fingerprint the
// WorkBuddy client via the system message.
func ApplyCodeBuddyRequestProfile(request *dto.GeneralOpenAIRequest) {
	if request == nil {
		return
	}
	model := "gpt-5.6-sol"
	if request.Model != "" {
		model = request.Model
	}
	systemContent := fmt.Sprintf(codeBuddySystemTemplate, model)
	if len(request.Messages) == 0 ||
		request.Messages[0].Role != "system" ||
		request.Messages[0].StringContent() != systemContent {
		request.Messages = append([]dto.Message{{
			Role:    "system",
			Content: systemContent,
		}}, request.Messages...)
	}
	// 以下参数仅在调用方未显式指定时给 WorkBuddy 默认值，其余情况原样透传，
	// 避免渠道覆盖下游客户端的温度/流式设置。
	if request.Stream == nil {
		stream := true
		request.Stream = &stream
	}
	if request.Temperature == nil {
		temperature := 1.0
		request.Temperature = &temperature
	}
	if request.ReasoningEffort == "" {
		request.ReasoningEffort = "low"
	}
	if request.StreamOptions == nil {
		request.StreamOptions = &dto.StreamOptions{IncludeUsage: true}
	}
}

func applyCodeBuddyHeaders(headers http.Header, apiKey, conversationID string, isStream bool) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		conversationID = uuid.NewString()
	}
	traceID := codeBuddyRandomHex(16)
	spanID := codeBuddyRandomHex(8)
	// 与官方客户端抓包一致：X-Request-ID 与 X-Conversation-Message-ID 共用 32-hex
	// messageId；X-Conversation-Request-ID 为独立的 32-hex。B3 链路中 span 与
	// parent span 相同。
	messageID := strings.ReplaceAll(uuid.NewString(), "-", "")
	conversationRequestID := strings.ReplaceAll(uuid.NewString(), "-", "")

	headers.Set("Authorization", "Bearer "+apiKey)
	headers.Set("X-API-Key", apiKey)
	headers.Set("Accept", "application/json")
	headers.Set("Content-Type", "application/json")
	headers.Set("User-Agent", "WorkBuddy/"+codeBuddyProductVersion+" WorkBuddy/"+codeBuddyProductVersion+" CLI/"+codeBuddyCLIUserAgent)
	headers.Set("X-Agent-Intent", "craft")
	headers.Set("X-Agent-Purpose", "conversation")
	headers.Set("X-Domain", "www.codebuddy.cn")
	headers.Set("X-IDE-Name", "WorkBuddy")
	headers.Set("X-IDE-Type", "WorkBuddy")
	headers.Set("X-IDE-Version", codeBuddyProductVersion)
	headers.Set("X-Product", "SaaS")
	headers.Set("X-Requested-With", "XMLHttpRequest")
	headers.Set("X-Stainless-Arch", "x64")
	headers.Set("X-Stainless-Lang", "js")
	headers.Set("X-Stainless-OS", "Windows")
	headers.Set("X-Stainless-Package-Version", "6.25.0")
	headers.Set("X-Stainless-Retry-Count", "0")
	headers.Set("X-Stainless-Runtime", "node")
	headers.Set("X-Stainless-Runtime-Version", "v22.21.1")
	// ACP 连接 ID 在同一会话内保持稳定（真实客户端在同一 ACP 连接生命周期内不变）。
	headers.Set("Acp-Connection-ID", uuid.NewSHA1(uuid.NameSpaceURL, []byte("workbuddy-acp:"+conversationID)).String())
	headers.Set("X-CodeBuddy-Request", "1")
	headers.Set("X-Conversation-ID", conversationID)
	headers.Set("X-Conversation-Message-ID", messageID)
	headers.Set("X-Conversation-Request-ID", conversationRequestID)
	headers.Set("X-Request-ID", messageID)
	// 用户维度标识：下游若已自带 X-User-Id 则透传，否则派生稳定 UUID（会话内不变）。
	// 对方非官方，无法校验真实 SSO 值，仅需保证格式合法。
	if headers.Get("X-User-Id") == "" {
		headers.Set("X-User-Id", codeBuddyUserUUID(conversationID))
	}
	headers.Set("B3", traceID+"-"+spanID+"-1-"+spanID)
	headers.Set("Traceparent", "00-"+traceID+"-"+spanID+"-01")
	headers.Set("X-B3-ParentSpanID", spanID)
	headers.Set("X-B3-Sampled", "1")
	headers.Set("X-B3-SpanID", spanID)
	headers.Set("X-B3-TraceID", traceID)
	headers.Set("X-Trace-ID", traceID)
}

// codeBuddyUserUUID derives a stable, UUID-shaped user identifier from the
// conversation key. It is a simulation stand-in for the SSO user id that the
// official client would send; non-official upstreams cannot validate it.
func codeBuddyUserUUID(conversationID string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("workbuddy-user:"+strings.TrimSpace(conversationID))).String()
}

// ResolveCodeBuddyConversationID maps a caller's stable conversation key to
// the UUID-shaped session ID emitted by the official WorkBuddy client. The
// raw key is never sent upstream.
func ResolveCodeBuddyConversationID(incoming http.Header, request dto.Request) string {
	if incoming != nil {
		if value := strings.TrimSpace(incoming.Get("X-Conversation-ID")); value != "" {
			if parsed, err := uuid.Parse(value); err == nil {
				return parsed.String()
			}
			return codeBuddyConversationUUID(value)
		}
	}

	var key string
	switch value := request.(type) {
	case *dto.GeneralOpenAIRequest:
		if value != nil {
			key = value.PromptCacheKey
		}
	case *dto.OpenAIResponsesRequest:
		if value != nil {
			key = codeBuddyJSONString(value.PromptCacheKey)
			if key == "" {
				key = codeBuddyJSONString(value.Conversation)
			}
		}
	}
	if key == "" {
		return ""
	}
	return codeBuddyConversationUUID(key)
}

func codeBuddyConversationUUID(key string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("workbuddy-conversation:"+strings.TrimSpace(key))).String()
}

func codeBuddyJSONString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func codeBuddyRandomHex(bytes int) string {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err == nil {
		return hex.EncodeToString(value)
	}
	fallback := strings.ReplaceAll(uuid.NewString(), "-", "")
	return fallback[:bytes*2]
}
