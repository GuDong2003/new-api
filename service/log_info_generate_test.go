package service

import (
	"testing"

	"github.com/QuantumNous/new-api/constant"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/stretchr/testify/assert"

	"github.com/gin-gonic/gin"
)

func TestGenerateTextOtherInfoLabelsImageGenerationEngine(t *testing.T) {
	gin.SetMode(gin.TestMode)
	context, _ := gin.CreateTestContext(nil)
	info := &relaycommon.RelayInfo{
		RelayFormat: types.RelayFormatOpenAIImage,
		ChannelMeta: &relaycommon.ChannelMeta{
			ChannelType: constant.ChannelTypeNovelAI,
		},
	}

	other := GenerateTextOtherInfo(context, info, 1, 1, 1, 0, 0, 0, 1)

	assert.Equal(t, "nai", other.Snapshot()["generation_engine"])
}
