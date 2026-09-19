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

// Drawing and NAI drop nodes onto the same grid and lay them out with the same
// gap. Both used to carry their own copy of these numbers, which had already
// drifted: one placed uploads 32px apart horizontally while everything else
// assumed 40.
export const CANVAS_NODE_WIDTH = 260
export const CANVAS_NODE_HEIGHT = 290
export const CANVAS_NODE_GAP = 40

// A node keeps its image readable even at the smallest size a drag can reach.
export const CANVAS_NODE_MIN_WIDTH = 200
export const CANVAS_NODE_MIN_HEIGHT = 200

export const CANVAS_NODE_STEP_X = CANVAS_NODE_WIDTH + CANVAS_NODE_GAP
export const CANVAS_NODE_STEP_Y = CANVAS_NODE_HEIGHT + CANVAS_NODE_GAP
