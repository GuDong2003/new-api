/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
package controller

import (
	"testing"

	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/stretchr/testify/assert"
)

func TestPlaygroundUsesImageRelayFormatForImagePaths(t *testing.T) {
	for _, testCase := range []struct {
		name string
		path string
		want types.RelayFormat
	}{
		{name: "chat", path: "/pg/chat/completions", want: types.RelayFormatOpenAI},
		{name: "image generation", path: "/pg/images/generations", want: types.RelayFormatOpenAIImage},
		{name: "image edit", path: "/pg/images/edits", want: types.RelayFormatOpenAIImage},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			assert.Equal(t, testCase.want, playgroundRelayFormat(testCase.path))
		})
	}
}
