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
  getCoreRowModel,
  useReactTable,
  type ColumnFiltersState,
} from '@tanstack/react-table'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance } from 'i18next'
import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { expect, test } from 'vitest'

import { DataTableToolbar } from '../toolbar'

// "image" is also the key of the unit images are counted in.
function GroupFilter(props: { translateLabels?: boolean }) {
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const table = useReactTable({
    data: [{ group: 'image' }],
    columns: [{ accessorKey: 'group' }],
    getCoreRowModel: getCoreRowModel(),
    state: { columnFilters },
    onColumnFiltersChange: setColumnFilters,
  })
  return (
    <DataTableToolbar
      table={table}
      filters={[
        {
          columnId: 'group',
          title: 'Group',
          options: [{ value: 'image', label: 'image' }],
          translateLabels: props.translateLabels,
        },
      ]}
    />
  )
}

async function openGroupFilter(translateLabels?: boolean) {
  const translations = createInstance()
  await translations.init({
    lng: 'zh',
    resources: { zh: { translation: { image: '张' } } },
  })
  const user = userEvent.setup()
  render(
    <I18nextProvider i18n={translations}>
      <GroupFilter translateLabels={translateLabels} />
    </I18nextProvider>
  )
  await user.click(screen.getByRole('button', { name: /Group/ }))
}

test('a filter of data shows an option named like a translation key as it is', async () => {
  await openGroupFilter(false)

  expect(await screen.findByRole('option', { name: 'image' })).toBeVisible()
  expect(screen.queryByText('张')).toBeNull()
})

test('a filter of translation keys shows each option translated', async () => {
  await openGroupFilter()

  expect(await screen.findByRole('option', { name: '张' })).toBeVisible()
})
