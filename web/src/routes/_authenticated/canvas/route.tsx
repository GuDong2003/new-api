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
  Link,
  Outlet,
  useRouterState,
} from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { Main } from '@/components/layout'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/_authenticated/canvas')({
  component: CanvasLayout,
})

function CanvasLayout() {
  const { t } = useTranslation()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const tabs = [
    { to: '/canvas/drawing', title: t('Drawing') },
    { to: '/canvas/nai', title: t('NAI Canvas') },
    { to: '/canvas/gallery', title: t('My Gallery') },
  ] as const

  return (
    <Main className='p-0'>
      <nav
        aria-label={t('Infinite Canvas')}
        className='flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-2 sm:px-4'
      >
        {tabs.map((tab) => (
          <Button
            key={tab.to}
            role='link'
            size='sm'
            variant={pathname === tab.to ? 'secondary' : 'ghost'}
            render={<Link to={tab.to} />}
          >
            {tab.title}
          </Button>
        ))}
      </nav>
      <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
        <Outlet />
      </div>
    </Main>
  )
}
