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
  Outlet,
  RouterProvider,
  type ParsedLocation,
} from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthenticatedLayout } from '@/components/layout/components/authenticated-layout'
import { DirectionProvider } from '@/context/direction-provider'
import { ThemeCustomizationProvider } from '@/context/theme-customization-provider'
import { ThemeProvider } from '@/context/theme-provider'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useDrawingStore } from '@/stores/drawing-store'
import { useNaiDrawingStore } from '@/stores/nai-drawing-store'

import { Route as DrawingRoute } from '../../playground/drawing'
import { Route as NaiRoute } from '../../playground/nai'
import { Route as PlaygroundRoute } from '../../playground/route'
import { Route as AuthRoute } from '../../route'
import { Route as CanvasIndex } from '../index'
import { Route as CanvasRoute } from '../route'

const adapter = api.defaults.adapter
// These production guards depend only on location, not the app's typed route tree.
type NavigationGuard = (context: {
  location: ParsedLocation
}) => void | Promise<void>
let client: QueryClient
beforeEach(() => {
  useDrawingStore.getState().initialize(0)
  useNaiDrawingStore.getState().initialize(0)
  localStorage.clear()
  window.localStorage.clear()
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  client.setQueryData(['status'], {
    system_name: 'New API',
    HeaderNavModules: '{}',
  })
  useAuthStore.getState().auth.setBundle({
    access_token: 'canvas-test-token',
    token_type: 'Bearer',
    access_expires_at: 9999999999,
    user: { id: 991, username: 'canvas-user', role: 1 },
    session: {
      sid: 'canvas-test-session',
      current: true,
      login_method: 'password',
      ip: '',
      user_agent: '',
      created_at: 1,
      last_active_at: 1,
      expires_at: 9999999999,
    },
  })
  api.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: 'OK',
    headers: {},
    data: {
      success: true,
      message: '',
      data: config.url === '/api/notice' ? '' : [],
    },
  })
})
afterEach(() => {
  client.clear()
  api.defaults.adapter = adapter
  useAuthStore.getState().auth.reset()
  localStorage.clear()
  window.localStorage.clear()
})

async function openWorkspace(path: string, shell = false) {
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <DirectionProvider>
            <ThemeCustomizationProvider>
              <Outlet />
            </ThemeCustomizationProvider>
          </DirectionProvider>
        </ThemeProvider>
      </QueryClientProvider>
    ),
  })
  const authenticated = createRoute({
    getParentRoute: () => root,
    id: '_authenticated',
    beforeLoad: AuthRoute.options.beforeLoad as NavigationGuard,
    component: shell ? AuthenticatedLayout : Outlet,
  })
  const canvas = createRoute({
    getParentRoute: () => authenticated,
    path: 'canvas',
    component: CanvasRoute.options.component,
  })
  const canvasIndex = createRoute({
    getParentRoute: () => canvas,
    path: '/',
    beforeLoad: CanvasIndex.options.beforeLoad as NavigationGuard,
  })
  const pages = ['drawing', 'nai', 'gallery'].map((path) =>
    createRoute({
      getParentRoute: () => canvas,
      path,
      component: () => <div>{path} page</div>,
    })
  )
  const playground = createRoute({
    getParentRoute: () => authenticated,
    path: 'playground',
    beforeLoad: PlaygroundRoute.options.beforeLoad as NavigationGuard,
    component: PlaygroundRoute.options.component,
  })
  const drawing = createRoute({
    getParentRoute: () => playground,
    path: 'drawing',
    beforeLoad: DrawingRoute.options.beforeLoad as NavigationGuard,
  })
  const nai = createRoute({
    getParentRoute: () => playground,
    path: 'nai',
    beforeLoad: NaiRoute.options.beforeLoad as NavigationGuard,
  })
  const chat = createRoute({
    getParentRoute: () => playground,
    path: 'chat',
    component: () => <div>chat page</div>,
  })
  const dashboard = createRoute({
    getParentRoute: () => authenticated,
    path: 'dashboard',
    component: () => <div>dashboard page</div>,
  })
  const signIn = createRoute({
    getParentRoute: () => root,
    path: 'sign-in',
    component: () => <div>sign in page</div>,
  })
  const router = createRouter({
    routeTree: root.addChildren([
      authenticated.addChildren([
        canvas.addChildren([canvasIndex, ...pages]),
        playground.addChildren([drawing, nai, chat]),
        dashboard,
      ]),
      signIn,
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}

describe('Canvas workspace navigation', () => {
  it('redirects the workspace root to Drawing', async () => {
    const router = await openWorkspace('/canvas')
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/canvas/drawing')
    )
  })

  it('provides three route tabs with current-page state and keyboard navigation', async () => {
    await openWorkspace('/canvas/drawing')
    const nav = screen.getByRole('navigation', { name: 'Infinite Canvas' })
    expect(within(nav).getAllByRole('link')).toHaveLength(3)
    expect(within(nav).getByRole('link', { name: 'Drawing' })).toHaveAttribute(
      'aria-current',
      'page'
    )
    await userEvent.click(within(nav).getByRole('link', { name: 'NAI Canvas' }))
    expect(await screen.findByText('nai page')).toBeVisible()
    const gallery = within(
      screen.getByRole('navigation', { name: 'Infinite Canvas' })
    ).getByRole('link', { name: 'My Gallery' })
    gallery.focus()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByText('gallery page')).toBeVisible()
    expect(screen.getByRole('link', { name: 'My Gallery' })).toHaveAttribute(
      'aria-current',
      'page'
    )
  })

  it.each([
    ['/playground/drawing', '/canvas/drawing'],
    ['/playground/nai', '/canvas/nai'],
  ])('redirects legacy %s even with playground disabled', async (from, to) => {
    window.localStorage.setItem(
      'status',
      JSON.stringify({
        SidebarModulesAdmin: '{"chat":{"enabled":false,"playground":false}}',
      })
    )
    const router = await openWorkspace(from)
    await waitFor(() => expect(router.state.location.pathname).toBe(to))
  })

  it('still gates actual playground chat when its module is disabled', async () => {
    window.localStorage.setItem(
      'status',
      JSON.stringify({ SidebarModulesAdmin: '{"chat":{"playground":false}}' })
    )
    const router = await openWorkspace('/playground/chat')
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/dashboard')
    )
  })

  it('retains actual playground chat when its module is enabled', async () => {
    await openWorkspace('/playground/chat')
    expect(await screen.findByText('chat page')).toBeVisible()
  })

  it('requires authentication for direct gallery access even when the top entry is hidden', async () => {
    useAuthStore.getState().auth.reset()
    window.localStorage.setItem(
      'status',
      '{"HeaderNavModules":"{\\"canvas\\":false}"}'
    )
    api.defaults.adapter = async (config) => ({
      config,
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { success: false, message: '' },
    })
    const router = await openWorkspace('/canvas/gallery')
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'))
    expect(router.state.location.search).toMatchObject({
      redirect: '/canvas/gallery',
    })
  })

  it('does not turn navigation visibility into an access gate for signed-in users', async () => {
    window.localStorage.setItem(
      'status',
      JSON.stringify({ HeaderNavModules: '{"canvas":false}' })
    )
    await openWorkspace('/canvas/gallery')
    expect(await screen.findByText('gallery page')).toBeVisible()
  })

  it('hides console sidebar and exposes a usable mobile site menu in the canvas shell', async () => {
    await openWorkspace('/canvas/drawing', true)
    expect(
      screen.queryAllByRole('button', { name: 'Toggle Sidebar' })
    ).toHaveLength(0)
    expect(screen.queryByRole('link', { name: 'API Keys' })).toBeNull()
    expect(
      within(screen.getByRole('banner')).getByRole('link', {
        name: 'Infinite Canvas',
      })
    ).toHaveAttribute('aria-current', 'page')
    const menu = screen.getByRole('button', { name: 'Toggle navigation menu' })
    expect(menu.closest('.hidden')).toBeNull()
    await userEvent.click(menu)
    const consoleEntry = await screen.findByRole('menuitem', {
      name: 'Console',
    })
    await userEvent.click(consoleEntry)
    expect(await screen.findByText('dashboard page')).toBeVisible()
    expect(
      screen.getAllByRole('button', { name: 'Toggle Sidebar' }).length
    ).toBeGreaterThan(0)
  })

  it('keeps both drawing persistence sessions alive while route tabs change', async () => {
    const router = await openWorkspace('/canvas/drawing', true)
    await waitFor(() =>
      expect(
        useDrawingStore.getState().ready && useNaiDrawingStore.getState().ready
      ).toBe(true)
    )
    act(() => {
      useDrawingStore
        .getState()
        .updateSettings({ prompt: 'Drawing draft stays' })
      useNaiDrawingStore
        .getState()
        .updateSettings({ prompt: 'NAI draft stays' })
    })
    await act(() => router.navigate({ to: '/canvas/nai' }))
    await act(() => router.navigate({ to: '/canvas/gallery' }))
    await act(() => router.navigate({ to: '/canvas/drawing' }))
    expect(useDrawingStore.getState().settings.prompt).toBe(
      'Drawing draft stays'
    )
    expect(useNaiDrawingStore.getState().settings.prompt).toBe(
      'NAI draft stays'
    )
  })
})
