/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

// Uploaded and generated images land on the canvas at this size and are laid
// out with the same gap. Each used to carry its own copy of these numbers,
// which drifted: generated images kept 280x330 after uploads shrank to
// 260x290, so the two sat side by side at different sizes.
export const CANVAS_NODE_WIDTH = 280
export const CANVAS_NODE_HEIGHT = 330
export const CANVAS_NODE_GAP = 40

// Layers sit further apart than siblings do. A connection leaves one image and
// enters the next from the side, so a narrow gap forces the curve to double
// back on itself between two images that are only slightly offset.
export const CANVAS_RANK_GAP = 120

// A node keeps its image readable even at the smallest size a drag can reach.
export const CANVAS_NODE_MIN_WIDTH = 200
export const CANVAS_NODE_MIN_HEIGHT = 200

export const CANVAS_NODE_STEP_X = CANVAS_NODE_WIDTH + CANVAS_NODE_GAP
export const CANVAS_NODE_STEP_Y = CANVAS_NODE_HEIGHT + CANVAS_NODE_GAP
