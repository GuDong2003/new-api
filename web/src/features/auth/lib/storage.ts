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
/**
 * Utilities for managing authentication-related browser storage
 */

// ============================================================================
// LocalStorage Keys
// ============================================================================

const STORAGE_KEYS = {
  AFFILIATE: 'aff',
  INVITATION: 'invite',
  OAUTH_INVITATION: 'oauth-registration-invite',
  STATUS: 'status',
} as const

// ============================================================================
// Affiliate Code Storage
// ============================================================================

/**
 * Get affiliate code from localStorage
 */
export function getAffiliateCode(): string {
  if (typeof window === 'undefined') return ''
  try {
    return window.localStorage.getItem(STORAGE_KEYS.AFFILIATE) ?? ''
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to get affiliate code:', error)
    return ''
  }
}

/**
 * Save affiliate code to localStorage
 */
export function saveAffiliateCode(code: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEYS.AFFILIATE, code)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to save affiliate code:', error)
  }
}

export function saveOAuthInvitationForState(state: string, code: string): void {
  if (typeof window === 'undefined') return
  try {
    const normalizedState = state.trim()
    const normalizedCode = code.trim()
    if (normalizedState && normalizedCode) {
      window.sessionStorage.setItem(
        STORAGE_KEYS.OAUTH_INVITATION,
        JSON.stringify({ state: normalizedState, code: normalizedCode })
      )
    } else {
      window.sessionStorage.removeItem(STORAGE_KEYS.OAUTH_INVITATION)
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to save OAuth invitation code:', error)
  }
}

export function takeOAuthInvitationForState(state: string): string {
  if (typeof window === 'undefined') return ''
  try {
    const rawValue = window.sessionStorage.getItem(
      STORAGE_KEYS.OAUTH_INVITATION
    )
    window.sessionStorage.removeItem(STORAGE_KEYS.OAUTH_INVITATION)
    if (!rawValue) return ''
    const value = JSON.parse(rawValue) as { state?: unknown; code?: unknown }
    if (
      value.state === state &&
      typeof value.code === 'string' &&
      value.code.trim()
    ) {
      return value.code.trim()
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to take OAuth invitation code:', error)
  }
  return ''
}

export function clearInvitationCode(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(STORAGE_KEYS.INVITATION)
    window.sessionStorage.removeItem(STORAGE_KEYS.OAUTH_INVITATION)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to clear invitation code:', error)
  }
}
