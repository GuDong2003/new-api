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
import { isAxiosError } from 'axios'

export function galleryErrorMessage(error: unknown): string {
  const message = isAxiosError(error)
    ? error.response?.data?.message
    : error instanceof Error && error.message
  switch (message) {
    case 'Gallery storage is disabled.':
    case 'Gallery storage limit reached.':
    case 'Gallery storage is unavailable.':
    case 'The gallery image is invalid.':
    case 'Gallery settings are invalid.':
    case 'The gallery image could not be saved.':
      return message
    default:
      return 'The gallery image could not be saved.'
  }
}
