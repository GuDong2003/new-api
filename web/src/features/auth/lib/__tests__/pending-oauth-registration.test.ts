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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { toast } from 'sonner'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { Route as OAuthCallbackRoute } from '@/routes/oauth/$provider'
import { useAuthStore, type AuthBundle } from '@/stores/auth-store'

import { isPendingOAuthRegistration } from '../../types.ts'

afterEach(() => {
  useAuthStore.getState().auth.reset()
  window.sessionStorage.clear()
})

describe('pending OAuth registration response', () => {
  test('accepts a complete one-time registration challenge', () => {
    expect(
      isPendingOAuthRegistration({
        require_invite_code: true,
        registration_token: 'registration-token',
        expires_at: 123,
      })
    ).toBe(true)
  })

  test('rejects incomplete or ordinary authentication payloads', () => {
    expect(
      isPendingOAuthRegistration({
        require_invite_code: true,
        registration_token: '',
        expires_at: 123,
      })
    ).toBe(false)
    expect(isPendingOAuthRegistration({ user: {}, session: {} })).toBe(false)
  })

  test.each(['success', 'server failure'] as const)(
    'an OAuth callback preserves the invitation gate when completion returns %s',
    async (outcome) => {
      vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
      useAuthStore.getState().auth.reset()
      window.sessionStorage.clear()
      const get = vi.spyOn(api, 'get').mockResolvedValue({
        data: {
          success: true,
          message: '',
          data: {
            require_invite_code: true,
            registration_token: 'pending-registration',
            expires_at: 1_900_000_000,
          },
        },
      })
      const bundle: AuthBundle = {
        access_token: 'registered-access-token',
        token_type: 'Bearer',
        access_expires_at: 1_900_000_000,
        user: { id: 7, username: 'registered-user', role: 1 },
        session: {
          sid: 'registered-session',
          current: true,
          login_method: 'oauth',
          ip: '127.0.0.1',
          user_agent: 'test',
          created_at: 1,
          last_active_at: 1,
          expires_at: 1_900_000_000,
        },
      }
      const post = vi.spyOn(api, 'post').mockResolvedValue({
        data: { success: true, message: '', data: bundle },
      })
      const notify = vi.spyOn(toast, 'error')
      if (outcome === 'server failure') {
        post.mockRejectedValue({
          isAxiosError: true,
          response: {
            status: 500,
            data: {
              message: 'Internal registration detail',
              message_key: 'Internal registration detail',
            },
          },
        })
      }
      const root = createRootRoute()
      const callback = createRoute({
        getParentRoute: () => root,
        path: 'oauth/$provider',
        component: OAuthCallbackRoute.options.component,
      })
      const dashboard = createRoute({
        getParentRoute: () => root,
        path: 'dashboard',
        component: () => createElement('div', null, 'Dashboard'),
      })
      const signIn = createRoute({
        getParentRoute: () => root,
        path: 'sign-in',
        component: () => createElement('div', null, 'Sign in'),
      })
      const router = createRouter({
        routeTree: root.addChildren([callback, dashboard, signIn]),
        history: createMemoryHistory({
          initialEntries: ['/oauth/github?code=oauth-code&state=oauth-state'],
        }),
      })
      const client = new QueryClient()
      client.setQueryData(['status'], { system_name: 'New API' })
      await router.load()
      const user = userEvent.setup()
      const view = render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(RouterProvider, { router })
        )
      )
      try {
        expect(
          await screen.findByRole('dialog', {
            name: 'Invitation Code Required',
          })
        ).toBeVisible()
        expect(useAuthStore.getState().auth.user).toBeNull()
        expect(post).not.toHaveBeenCalled()
        await user.type(
          screen.getByRole('textbox', { name: 'Invitation Code' }),
          'invite-code'
        )
        await user.click(screen.getByRole('button', { name: 'Continue' }))

        if (outcome === 'success') {
          await waitFor(() =>
            expect(router.state.location.pathname).toBe('/dashboard')
          )
          expect(useAuthStore.getState().auth.user?.id).toBe(7)
        } else {
          await waitFor(() =>
            expect(notify).toHaveBeenCalledWith('Please try again later.')
          )
          expect(useAuthStore.getState().auth.user).toBeNull()
          expect(
            screen.getByRole('dialog', { name: 'Invitation Code Required' })
          ).toBeVisible()
        }
        expect(get).toHaveBeenCalledExactlyOnceWith(
          '/api/oauth/github',
          expect.objectContaining({
            skipAuthRefresh: true,
            params: expect.objectContaining({
              code: 'oauth-code',
              state: 'oauth-state',
            }),
          })
        )
        expect(post).toHaveBeenCalledExactlyOnceWith(
          '/api/oauth/registration',
          {
            registration_token: 'pending-registration',
            invite_code: 'invite-code',
          },
          expect.objectContaining({ skipAuthRefresh: true })
        )
      } finally {
        view.unmount()
        client.clear()
      }
    }
  )
})
