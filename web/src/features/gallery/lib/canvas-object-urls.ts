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
import type { CanvasKind } from '../types'

// A canvas carries a few dozen full-size pictures. Handing them to the editor
// as data URLs meant base64-encoding every one while the canvas opened, and
// holding a third more bytes than the pictures actually take for as long as it
// stayed open. Object URLs avoid both, but have to be handed back.
//
// Ownership sits with the open canvas rather than with each node: the editor
// swaps its whole document at once, so a canvas releases its URLs when the next
// one is decoded and when the editor stops. A node deleted mid-session keeps
// its URL until then, which costs one entry rather than a correctness risk.
const openCanvasUrls = new Map<CanvasKind, string[]>()

export function adoptCanvasObjectUrls(kind: CanvasKind, urls: string[]) {
  releaseCanvasObjectUrls(kind)
  if (urls.length) openCanvasUrls.set(kind, urls)
}

export function releaseCanvasObjectUrls(kind: CanvasKind) {
  for (const url of openCanvasUrls.get(kind) ?? []) URL.revokeObjectURL(url)
  openCanvasUrls.delete(kind)
}
