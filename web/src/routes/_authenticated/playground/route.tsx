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
import { createFileRoute, Link, Outlet, redirect } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { Main } from '@/components/layout'
import { Button } from '@/components/ui/button'
import { isSidebarModuleEnabled } from '@/lib/nav-modules'

export const Route = createFileRoute('/_authenticated/playground')({
  beforeLoad: () => {
    if (!isSidebarModuleEnabled('chat', 'playground')) {
      throw redirect({ to: '/dashboard' })
    }
  },
  component: PlaygroundLayout,
})

function PlaygroundLayout() {
  const { t } = useTranslation()

  return (
    <Main className='p-0'>
      <div className='flex h-12 shrink-0 items-center gap-5 border-b px-4'>
        <h1 className='text-sm font-semibold'>{t('Playground')}</h1>
        <nav aria-label={t('Playground')} className='flex items-center gap-1'>
          <Button
            nativeButton={false}
            render={
              <Link
                activeProps={{
                  className: 'bg-muted text-foreground',
                  'aria-current': 'page',
                }}
                to='/playground/chat'
              />
            }
            size='sm'
            variant='ghost'
          >
            {t('Chat')}
          </Button>
          <Button
            nativeButton={false}
            render={
              <Link
                activeProps={{
                  className: 'bg-muted text-foreground',
                  'aria-current': 'page',
                }}
                to='/playground/drawing'
              />
            }
            size='sm'
            variant='ghost'
          >
            {t('Drawing')}
          </Button>
        </nav>
      </div>
      <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
        <Outlet />
      </div>
    </Main>
  )
}
