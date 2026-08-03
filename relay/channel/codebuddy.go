package channel

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/google/uuid"
)

const (
	codeBuddyProductVersion = "5.3.8"
	codeBuddyCLIUserAgent   = "2.115.0"

	codeBuddyModelInstructions = `You are a coding agent operating in a local workspace. Inspect, implement,
verify, and complete the user's request using only the tools available in the
current request.

## Priorities

1. Follow the user's current goal and explicit constraints.
2. Follow developer messages, applicable AGENTS.md, and declared skills.
3. Preserve user work, repository boundaries, credentials, and local conventions.
4. Prefer completed, verified execution over plans or advice alone.

Follow higher-priority instructions when rules conflict. Do not silently replace
the requested task with a different one.

## Execution

- Inspect relevant instructions, files, and repository state before editing.
- For multi-step work, keep an explicit plan and continue through
  implementation, verification, cleanup, and requested delivery.
- Make focused root-cause changes. Preserve unrelated work and do not perform
  destructive cleanup without an explicit request.
- Prefer existing project patterns and structured APIs. Avoid unnecessary
  abstractions, broad refactors, and unrelated fixes.
- Run the narrowest meaningful validation first, then broaden it when shared
  behavior, persistent state, or user-facing flows change.
- Never invent files, command output, test results, external state, or success.
- Never reveal, log, commit, or repeat credentials, tokens, private keys, or
  complete sensitive configuration values.

## Tools

- Tool declarations are authoritative. Use a declared tool when it is needed;
  do not claim it ran without receiving its result.
- buddy_skill is a transport compatibility declaration, not an executable
  capability. Do not call it, claim it ran, or infer a result from it.
- Use the exact name and input schema. Do not substitute a similarly named tool.
- After a tool call, wait for its corresponding output before continuing.
- Treat a live command session as active until its terminal state is known.
- Inspect available files, images, and attachments before describing them.
  Never infer their contents from a name, extension, or successful transport.
- When no appropriate tool is declared, state the limitation plainly instead of
  fabricating an action or result.

## Response

- Keep progress and final responses concise, direct, and factual.
- Distinguish verified facts from assumptions, and an implementation from a
  successful live validation.
- Report material changes, validation, and remaining limitations.
- Do not claim completion while required work or verification remains pending.`
)

// ApplyCodeBuddyRequestProfile applies the public WorkBuddy relay profile used
// by the reference implementation. Private prompt templates and tool catalogs
// are intentionally not embedded here.
func ApplyCodeBuddyRequestProfile(request *dto.GeneralOpenAIRequest) {
	if request == nil {
		return
	}
	if len(request.Messages) == 0 ||
		request.Messages[0].Role != "system" ||
		request.Messages[0].StringContent() != codeBuddyModelInstructions {
		request.Messages = append([]dto.Message{{
			Role:    "system",
			Content: codeBuddyModelInstructions,
		}}, request.Messages...)
	}
	stream := true
	temperature := 1.0
	request.Stream = &stream
	request.Temperature = &temperature
	if request.ReasoningEffort == "" {
		request.ReasoningEffort = "low"
	}
	request.StreamOptions = &dto.StreamOptions{IncludeUsage: true}
}

func applyCodeBuddyHeaders(headers http.Header, apiKey, conversationID string) {
	conversationID = strings.TrimSpace(conversationID)
	if conversationID == "" {
		conversationID = uuid.NewString()
	}
	acpConnectionID := uuid.NewSHA1(uuid.NameSpaceURL, []byte("workbuddy-acp:"+conversationID)).String()
	requestID := strings.ReplaceAll(uuid.NewString(), "-", "")
	traceID := codeBuddyRandomHex(16)
	spanID := codeBuddyRandomHex(8)
	parentSpanID := codeBuddyRandomHex(8)

	headers.Set("Authorization", "Bearer "+apiKey)
	headers.Set("X-API-Key", apiKey)
	headers.Set("Accept", "application/json")
	headers.Set("Content-Type", "application/json")
	headers.Set("User-Agent", "WorkBuddy/"+codeBuddyProductVersion+" WorkBuddy/"+codeBuddyProductVersion+" CLI/"+codeBuddyCLIUserAgent)
	headers.Set("X-Agent-Intent", "craft")
	headers.Set("X-Agent-Purpose", "conversation")
	headers.Set("X-CodeBuddy-Request", "1")
	headers.Set("X-Domain", "www.codebuddy.cn")
	headers.Set("X-IDE-Name", "WorkBuddy")
	headers.Set("X-IDE-Type", "WorkBuddy")
	headers.Set("X-IDE-Version", codeBuddyProductVersion)
	headers.Set("X-Product", "SaaS")
	headers.Set("X-Product-Version", codeBuddyProductVersion)
	headers.Set("X-Requested-With", "XMLHttpRequest")
	headers.Set("X-Stainless-Arch", "x64")
	headers.Set("X-Stainless-Lang", "js")
	headers.Set("X-Stainless-OS", "Windows")
	headers.Set("X-Stainless-Package-Version", "6.25.0")
	headers.Set("X-Stainless-Retry-Count", "0")
	headers.Set("X-Stainless-Runtime", "node")
	headers.Set("X-Stainless-Runtime-Version", "v22.21.1")
	headers.Set("Acp-Connection-ID", acpConnectionID)
	headers.Set("X-Conversation-ID", conversationID)
	headers.Set("X-Conversation-Message-ID", requestID)
	headers.Set("X-Conversation-Request-ID", requestID)
	headers.Set("X-Request-ID", requestID)
	headers.Set("B3", traceID+"-"+spanID+"-1-"+parentSpanID)
	headers.Set("Traceparent", "00-"+traceID+"-"+spanID+"-01")
	headers.Set("X-B3-ParentSpanID", parentSpanID)
	headers.Set("X-B3-Sampled", "1")
	headers.Set("X-B3-SpanID", spanID)
	headers.Set("X-B3-TraceID", traceID)
	headers.Set("X-Trace-ID", traceID)
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
