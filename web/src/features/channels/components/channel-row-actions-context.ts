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
import { createContext } from 'react'

/**
 * Where channel row-derived controls are being rendered. Card view can tune
 * compact display details while table view keeps the full desktop treatment.
 */
export type ChannelRowActionsLayout = 'table' | 'card'

export const ChannelRowActionsLayoutContext =
  createContext<ChannelRowActionsLayout>('table')

/**
 * Container classes for a row's action buttons.
 *
 * Table view puts them in a right-pinned column whose width follows the widest
 * row, while only the upstream-account buttons are conditional. Aligning to the
 * column's right edge therefore keeps the buttons every row has — edit, test,
 * status and the overflow menu — in line down the column, and the negative
 * margin pulls the last button's optical edge back to the cell padding.
 *
 * Card view sizes this group to its content, so it stays left-aligned and only
 * needs its first button pulled back against the card header.
 */
export function channelRowActionsClassName(
  layout: ChannelRowActionsLayout
): string {
  if (layout === 'card') {
    return '-ml-1.5 flex items-center gap-1'
  }
  return '-mr-1.5 flex items-center justify-end gap-1'
}
