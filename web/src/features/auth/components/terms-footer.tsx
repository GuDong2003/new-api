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
import { Trans, useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import type { SystemStatus } from '../types'

interface TermsFooterProps {
  variant?: 'sign-in' | 'sign-up'
  className?: string
  status?: SystemStatus | null
}

const termsMessages = {
  'sign-in': {
    both: 'By clicking sign in, you agree to our <agreement>User Agreement</agreement> and <privacy>Privacy Policy</privacy>.',
    agreement:
      'By clicking sign in, you agree to our <agreement>User Agreement</agreement>.',
    privacy:
      'By clicking sign in, you agree to our <privacy>Privacy Policy</privacy>.',
  },
  'sign-up': {
    both: 'By creating an account, you agree to our <agreement>User Agreement</agreement> and <privacy>Privacy Policy</privacy>.',
    agreement:
      'By creating an account, you agree to our <agreement>User Agreement</agreement>.',
    privacy:
      'By creating an account, you agree to our <privacy>Privacy Policy</privacy>.',
  },
} as const

export function TermsFooter(props: TermsFooterProps) {
  const { t } = useTranslation()
  const hasUserAgreement = Boolean(props.status?.user_agreement_enabled)
  const hasPrivacyPolicy = Boolean(props.status?.privacy_policy_enabled)
  if (!hasUserAgreement && !hasPrivacyPolicy) return null

  let documents: 'both' | 'agreement' | 'privacy' = 'both'
  if (!hasPrivacyPolicy) documents = 'agreement'
  else if (!hasUserAgreement) documents = 'privacy'

  return (
    <p
      className={cn(
        'text-muted-foreground text-center text-xs',
        props.className
      )}
    >
      <Trans
        t={t}
        i18nKey={termsMessages[props.variant ?? 'sign-in'][documents]}
        components={{
          agreement: (
            <a
              href='/user-agreement'
              className='hover:text-primary underline underline-offset-4'
            />
          ),
          privacy: (
            <a
              href='/privacy-policy'
              className='hover:text-primary underline underline-offset-4'
            />
          ),
        }}
      />
    </p>
  )
}
