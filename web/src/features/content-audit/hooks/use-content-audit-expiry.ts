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
import { useEffect, useEffectEvent } from 'react'

export function useContentAuditExpiry(
  expiresAt: number | undefined,
  onExpire: () => void
) {
  const expire = useEffectEvent(onExpire)
  useEffect(() => {
    if (expiresAt === undefined) return
    let timer: number
    const checkExpiry = () => {
      const remaining = expiresAt * 1000 - Date.now()
      if (remaining <= 0) {
        expire()
        return
      }
      // Thirty-day retention can exceed the browser's signed 32-bit timer.
      timer = window.setTimeout(checkExpiry, Math.min(remaining, 2147483647))
    }
    checkExpiry()
    return () => window.clearTimeout(timer)
  }, [expiresAt])
}
