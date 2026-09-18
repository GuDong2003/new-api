package zhipu_4v

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestZhipuV4ForwardsRequestedReasoningEffort(t *testing.T) {
	request := dto.GeneralOpenAIRequest{
		Model:           "glm-4.6",
		ReasoningEffort: "high",
		Messages: []dto.Message{{
			Role:    "user",
			Content: "hello",
		}},
	}

	payload, err := common.Marshal(requestOpenAI2Zhipu(request))
	require.NoError(t, err)
	var upstream map[string]any
	require.NoError(t, common.Unmarshal(payload, &upstream))
	assert.Equal(t, "high", upstream["reasoning_effort"])
}
