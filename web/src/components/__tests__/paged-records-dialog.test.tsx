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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test } from 'vitest'

import { PagedRecordsDialog, type PagedRecords } from '../paged-records-dialog'

type Row = { id: number; label: string }

const clients: QueryClient[] = []

function dialog(props: {
  subject: number
  fetchPage: (page: number, pageSize: number) => Promise<PagedRecords<Row>>
}) {
  return (
    <PagedRecordsDialog<Row>
      open
      onOpenChange={() => undefined}
      title='Records'
      queryKey={['test-records', props.subject]}
      enabled
      fetchPage={props.fetchPage}
      columns={[{ id: 'label', header: 'Label', cell: (row) => row.label }]}
      getRowKey={(row) => row.id}
      emptyText='Nothing yet'
      totalText={(total) => `${total} in all`}
      pageSize={2}
    />
  )
}

function renderDialog(props: Parameters<typeof dialog>[0]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  const view = render(
    <QueryClientProvider client={client}>{dialog(props)}</QueryClientProvider>
  )
  return {
    rerender: (next: Parameters<typeof dialog>[0]) =>
      view.rerender(
        <QueryClientProvider client={client}>
          {dialog(next)}
        </QueryClientProvider>
      ),
  }
}

afterEach(() => {
  for (const client of clients) client.clear()
  clients.length = 0
})

test('shows the rows of the loaded page and the total', async () => {
  renderDialog({
    subject: 1,
    fetchPage: async () => ({ items: [{ id: 1, label: 'first' }], total: 1 }),
  })

  expect(await screen.findByText('first')).toBeInTheDocument()
  expect(screen.getByText('1 in all')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
})

test('never shows the records of the previous subject while the next loads', async () => {
  const view = renderDialog({
    subject: 1,
    fetchPage: async () => ({ items: [{ id: 1, label: 'from A' }], total: 1 }),
  })
  expect(await screen.findByText('from A')).toBeInTheDocument()

  view.rerender({ subject: 2, fetchPage: () => new Promise(() => undefined) })

  await waitFor(() =>
    expect(screen.queryByText('from A')).not.toBeInTheDocument()
  )
  expect(screen.getByText('Loading...')).toBeInTheDocument()
})

test('reports a failed load instead of an empty list', async () => {
  renderDialog({
    subject: 1,
    fetchPage: async () => {
      throw new Error('records are unavailable')
    },
  })

  expect(await screen.findByText('records are unavailable')).toBeInTheDocument()
  expect(screen.queryByText('Nothing yet')).not.toBeInTheDocument()
})

test('moves to the next page and back', async () => {
  const user = userEvent.setup()
  const requested: number[] = []
  renderDialog({
    subject: 1,
    fetchPage: async (page) => {
      requested.push(page)
      return {
        items: [{ id: page, label: `row on page ${page}` }],
        total: 5,
      }
    },
  })
  expect(await screen.findByText('row on page 1')).toBeInTheDocument()
  expect(screen.getByText('1 / 3')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Next' }))
  expect(await screen.findByText('row on page 2')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Previous' }))
  expect(await screen.findByText('row on page 1')).toBeInTheDocument()
  expect(requested).toContain(2)
})
