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
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { cn } from '@/lib/utils'

type TurnstileAPI = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileAPI
  }
}

interface TurnstileProps {
  siteKey: string
  onVerify: (token: string) => void
  onExpire?: () => void
  className?: string
}

// All mounted widgets await the same script. A script tag alone does not mean
// the API is ready, and an unsuccessful attempt must allow a fresh download.
let scriptPromise: Promise<TurnstileAPI> | undefined

function loadTurnstile(): Promise<TurnstileAPI> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise<TurnstileAPI>((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>(
      'script#cf-turnstile'
    )
    const existing = Boolean(script)
    if (!script) {
      script = document.createElement('script')
      script.id = 'cf-turnstile'
      script.src =
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      script.defer = true
    }
    const element = script
    const timer = window.setTimeout(failed, 20_000)

    function cleanListeners() {
      window.clearTimeout(timer)
      element.removeEventListener('load', loaded)
      element.removeEventListener('error', failed)
    }

    function loaded() {
      if (!window.turnstile) {
        failed()
        return
      }
      cleanListeners()
      resolve(window.turnstile)
    }

    function failed() {
      cleanListeners()
      element.remove()
      scriptPromise = undefined
      reject(new Error('Turnstile script unavailable'))
    }

    element.addEventListener('load', loaded, { once: true })
    element.addEventListener('error', failed, { once: true })
    if (!existing) document.head.appendChild(element)
  })
  return scriptPromise
}

export function Turnstile(props: TurnstileProps) {
  const { t } = useTranslation()
  const element = useRef<HTMLDivElement | null>(null)
  const verified = useRef(false)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorCode, setErrorCode] = useState<string>()
  const [expired, setExpired] = useState(false)
  const onVerify = useEffectEvent((token: string) => props.onVerify(token))
  const onExpire = useEffectEvent(() => props.onExpire?.())

  useEffect(() => {
    let cancelled = false
    let api: TurnstileAPI | undefined
    let widgetId: string | undefined
    verified.current = false
    setStatus('loading')
    setErrorCode(undefined)
    setExpired(false)

    void loadTurnstile().then(
      (loadedAPI) => {
        if (cancelled || !element.current) return
        api = loadedAPI
        try {
          widgetId = api.render(element.current, {
            sitekey: props.siteKey,
            callback: (token: string) => {
              if (cancelled || !token) return
              verified.current = true
              setStatus('ready')
              setErrorCode(undefined)
              setExpired(false)
              onVerify(token)
            },
            'error-callback': (code: string) => {
              if (cancelled) return true
              if (verified.current) {
                verified.current = false
                onExpire()
              }
              setErrorCode(/^\d{6}$/.test(code) ? code : undefined)
              setExpired(false)
              setStatus('error')
              return true
            },
            'expired-callback': () => {
              if (cancelled) return
              verified.current = false
              onExpire()
              setExpired(true)
              setErrorCode(undefined)
              setStatus('error')
            },
            'timeout-callback': () => {
              if (cancelled) return
              if (verified.current) {
                verified.current = false
                onExpire()
              }
              setExpired(true)
              setErrorCode(undefined)
              setStatus('error')
            },
          })
          setStatus('ready')
        } catch {
          setStatus('error')
        }
      },
      () => {
        if (!cancelled) setStatus('error')
      }
    )
    return () => {
      cancelled = true
      if (widgetId && api) api.remove(widgetId)
    }
  }, [props.siteKey, attempt])

  const retry = () => {
    if (verified.current) {
      verified.current = false
      props.onExpire?.()
    }
    setStatus('loading')
    setAttempt((current) => current + 1)
  }
  let description = t(
    'Human verification could not load. Please retry or try another network.'
  )
  if (expired) description = t('Human verification expired. Please retry.')
  if (errorCode) {
    description = `${description} ${t('Error code: {{code}}', { code: errorCode })}`
  }

  return (
    <div className={cn('space-y-2', props.className)}>
      <div ref={element} />
      {status === 'loading' && (
        <div role='status'>
          <LoadingState
            inline
            size='sm'
            message={t('Loading human verification…')}
          />
        </div>
      )}
      {status === 'error' && (
        <div role='alert'>
          <ErrorState
            className='min-h-0 border-0 p-0'
            title={t('Human verification unavailable')}
            description={description}
            onRetry={retry}
          />
        </div>
      )}
    </div>
  )
}
