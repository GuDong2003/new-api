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
import {
  createFileRoute,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router'
import type { AxiosRequestConfig } from 'axios'
import i18next from 'i18next'
import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { completeOAuthRegistration } from '@/features/auth/api'
import { OAuthCallbackScreen } from '@/features/auth/components/oauth-callback-screen'
import {
  OAUTH_POPUP_CALLBACK_MESSAGE,
  OAUTH_POPUP_RESULT_MESSAGE,
} from '@/features/auth/constants'
import { useAuthRedirect } from '@/features/auth/hooks/use-auth-redirect'
import { sanitizeAuthRedirect } from '@/features/auth/lib/auth-redirect'
import {
  parseTelegramBindCallback,
  postTelegramBindResult,
  startOAuthBindResponseDeadline,
} from '@/features/auth/lib/oauth-bind-window'
import {
  getOAuthSessionStorage,
  consumeOAuthLoginRedirect,
  resolveOAuthCallbackMode,
} from '@/features/auth/lib/oauth-callback-mode'
import { takeOAuthInvitationForState } from '@/features/auth/lib/storage'
import {
  isPendingOAuthRegistration,
  type LoginResponse,
} from '@/features/auth/types'
import { api, applyAuthBundle, isAuthBundle } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { AuthOperationError } from '@/lib/secure-verification'
import { getServerErrorMessageKey } from '@/lib/server-error-message'

type OAuthRequestConfig = AxiosRequestConfig & {
  skipBusinessError?: boolean
  skipAuthRefresh?: boolean
}

interface OAuthPopupResult {
  intent: 'bind' | 'verify'
  type: typeof OAUTH_POPUP_RESULT_MESSAGE
  provider: string
  state: string
  success: boolean
  message?: string
}

function OAuthCallback() {
  const navigate = useNavigate()
  const { handleLoginResult } = useAuthRedirect()
  const loginExchange = useRef<{
    key: string
    request: Promise<{ data: LoginResponse }>
  } | null>(null)
  const completedLogin = useRef<string | null>(null)
  const loginCallbackHandledRef = useRef(false)
  const [registrationToken, setRegistrationToken] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [isCompletingRegistration, setIsCompletingRegistration] =
    useState(false)
  const { provider } = useParams({ from: '/oauth/$provider' }) as {
    provider: string
  }
  const search = useSearch({ from: '/oauth/$provider' }) as {
    code?: string
    state?: string
    error?: string
    error_description?: string
    redirect?: string
    telegram_bind?: string
    flow_token?: string
    error_code?: string
  }
  const callbackState = search.state ?? ''
  const isTelegramBindCallback =
    provider === 'telegram' &&
    (search.telegram_bind === 'success' || search.telegram_bind === 'error')
  let mode: 'login' | 'bind' | 'verify' = 'login'
  if (isTelegramBindCallback) {
    mode = 'bind'
  } else if (typeof window !== 'undefined') {
    mode = resolveOAuthCallbackMode(provider, callbackState, {
      opener: window.opener,
      storage: getOAuthSessionStorage(window),
    })
  }

  const safeNavigate = useCallback(
    (target: unknown, fallback = '/dashboard') => {
      const href =
        sanitizeAuthRedirect(target, window.location.origin) ?? fallback
      void navigate({ href, replace: true })
    },
    [navigate]
  )

  const handleInvitationDialogChange = (open: boolean) => {
    if (open) return
    setRegistrationToken('')
    setInviteCode('')
    safeNavigate('/sign-in', '/sign-in')
  }

  const handleCompleteRegistration = async () => {
    const normalizedInviteCode = inviteCode.trim()
    if (!registrationToken || !normalizedInviteCode) {
      toast.error(i18next.t('Please enter an invitation code'))
      return
    }
    setIsCompletingRegistration(true)
    try {
      const response = await completeOAuthRegistration(
        registrationToken,
        normalizedInviteCode
      )
      if (response?.success && isAuthBundle(response.data)) {
        applyAuthBundle(response.data)
        setRegistrationToken('')
        safeNavigate(search.redirect)
        toast.success(i18next.t('Signed in successfully!'))
        return
      }
      const messageKey = getServerErrorMessageKey(response)
      toast.error(
        messageKey
          ? i18next.t(messageKey)
          : response?.message || i18next.t('OAuth failed')
      )
    } catch (error: unknown) {
      const messageKey = getServerErrorMessageKey(error)
      const responseMessage = (
        error as { response?: { data?: { message?: string } } }
      ).response?.data?.message
      toast.error(
        messageKey
          ? i18next.t(messageKey)
          : responseMessage || i18next.t('OAuth failed')
      )
    } finally {
      setIsCompletingRegistration(false)
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return

    const code = search.code ?? ''
    const state = callbackState
    const telegramCallback =
      provider === 'telegram'
        ? parseTelegramBindCallback({
            telegram_bind: search.telegram_bind,
            flow_token: search.flow_token,
            error_code: search.error_code,
          })
        : null
    if (telegramCallback) {
      const opener = window.opener
      if (
        !postTelegramBindResult(
          telegramCallback,
          opener,
          window.location.origin
        )
      ) {
        toast.error(i18next.t('Telegram binding failed. Please try again.'))
        const closeTimeout = window.setTimeout(() => window.close(), 1500)
        return () => window.clearTimeout(closeTimeout)
      }
      window.close()
      return
    }

    if (mode === 'bind' || mode === 'verify') {
      const opener = window.opener
      if (!opener || opener.closed) {
        toast.error(i18next.t('OAuth window is no longer available.'))
        return
      }

      let cancelResultTimeout: () => void = () => undefined
      let delayedClose: number | undefined
      const handleBindingResult = (event: MessageEvent<unknown>) => {
        if (
          event.origin !== window.location.origin ||
          event.source !== opener
        ) {
          return
        }
        const result = event.data as Partial<OAuthPopupResult> | null
        if (
          !result ||
          result.type !== OAUTH_POPUP_RESULT_MESSAGE ||
          result.intent !== mode ||
          result.provider !== provider ||
          result.state !== state
        ) {
          return
        }
        cancelResultTimeout()
        if (result.success) {
          if (mode === 'bind') toast.success(i18next.t('Binding successful!'))
          window.close()
          return
        }
        handleServerError(result, i18next.t('OAuth failed'))
        delayedClose = window.setTimeout(() => window.close(), 1500)
      }

      window.addEventListener('message', handleBindingResult)
      cancelResultTimeout = startOAuthBindResponseDeadline(() => {
        toast.error(
          i18next.t('OAuth authorization timed out. Please try again.')
        )
        delayedClose = window.setTimeout(() => window.close(), 1500)
      })
      opener.postMessage(
        {
          type: OAUTH_POPUP_CALLBACK_MESSAGE,
          intent: mode,
          provider,
          code,
          state,
          error: search.error,
          errorDescription: search.error_description,
        },
        window.location.origin
      )
      return () => {
        window.removeEventListener('message', handleBindingResult)
        cancelResultTimeout()
        if (delayedClose !== undefined) window.clearTimeout(delayedClose)
      }
    }

    if (loginCallbackHandledRef.current) return
    loginCallbackHandledRef.current = true
    const callbackInvitationCode = takeOAuthInvitationForState(state)

    if (!code && !search.error) {
      toast.error(i18next.t('Missing code'))
      safeNavigate('/sign-in', '/sign-in')
      return
    }

    const loginKey = `${provider}:${state}:${code}`
    if (completedLogin.current === loginKey) return
    let active = true
    void (async () => {
      try {
        const config: OAuthRequestConfig = {
          params: {
            code: code || undefined,
            state,
            error: search.error,
            error_description: search.error_description,
          },
          skipBusinessError: true,
          skipAuthRefresh: true,
        }
        if (loginExchange.current?.key !== loginKey) {
          loginExchange.current = {
            key: loginKey,
            request: api.get<LoginResponse>(`/api/oauth/${provider}`, config),
          }
        }
        const response = await loginExchange.current.request
        if (!active) return
        if (response.data?.success) {
          completedLogin.current = loginKey
          if (
            await handleLoginResult(
              response.data.data,
              search.redirect ?? consumeOAuthLoginRedirect(state) ?? undefined
            )
          ) {
            toast.success(i18next.t('Signed in successfully!'))
          }
          return
        }
        if (
          response.data?.success &&
          isPendingOAuthRegistration(response.data?.data)
        ) {
          setInviteCode(callbackInvitationCode)
          setRegistrationToken(response.data.data.registration_token)
          return
        }
        const messageKey = getServerErrorMessageKey(response.data)
        handleServerError(
          response.data,
          messageKey
            ? i18next.t(messageKey)
            : response.data?.message || i18next.t('OAuth failed')
        )
      } catch (error: unknown) {
        if (!active) return
        handleServerError(
          AuthOperationError.from(error, i18next.t('OAuth failed'))
        )
      }
      safeNavigate('/sign-in', '/sign-in')
    })()
    return () => {
      active = false
    }
  }, [
    callbackState,
    handleLoginResult,
    mode,
    provider,
    safeNavigate,
    search.code,
    search.error,
    search.error_code,
    search.error_description,
    search.flow_token,
    search.redirect,
    search.telegram_bind,
  ])

  return (
    <>
      <OAuthCallbackScreen provider={provider} mode={mode} />
      <Dialog
        open={Boolean(registrationToken)}
        onOpenChange={handleInvitationDialogChange}
        title={i18next.t('Invitation Code Required')}
        description={i18next.t(
          'Enter a valid invitation code before continuing registration.'
        )}
        contentClassName='max-w-sm'
        contentHeight='auto'
        footer={
          <>
            <Button
              type='button'
              variant='outline'
              disabled={isCompletingRegistration}
              onClick={() => handleInvitationDialogChange(false)}
            >
              {i18next.t('Cancel')}
            </Button>
            <Button
              type='button'
              className='gap-2'
              disabled={isCompletingRegistration || !inviteCode.trim()}
              onClick={() => void handleCompleteRegistration()}
            >
              {isCompletingRegistration ? (
                <Loader2 className='h-4 w-4 animate-spin' />
              ) : null}
              {i18next.t('Continue')}
            </Button>
          </>
        }
      >
        <div className='grid gap-2'>
          <Label htmlFor='oauth-registration-invite-code'>
            {i18next.t('Invitation Code')}
          </Label>
          <Input
            id='oauth-registration-invite-code'
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && inviteCode.trim()) {
                event.preventDefault()
                void handleCompleteRegistration()
              }
            }}
            placeholder={i18next.t('Enter your invitation code')}
            autoComplete='one-time-code'
            autoCapitalize='characters'
            spellCheck={false}
            autoFocus
          />
        </div>
      </Dialog>
    </>
  )
}

export const Route = createFileRoute('/oauth/$provider')({
  component: OAuthCallback,
})
