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
import { Background, BackgroundVariant } from '@xyflow/react'

// The dot grid gives the canvas a sense of scale while panning, so it has to be
// legible. The border colour sits within a few percent of the canvas in both
// themes, which left the grid invisible; the muted foreground is the nearest
// token with real contrast, thinned so it never competes with the images.
export function CanvasBackground() {
  return (
    <Background
      variant={BackgroundVariant.Dots}
      gap={20}
      size={1.5}
      color='color-mix(in oklch, var(--muted-foreground) 35%, transparent)'
    />
  )
}
