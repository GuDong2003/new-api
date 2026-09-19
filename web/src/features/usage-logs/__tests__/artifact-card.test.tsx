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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { TaskArtifactsCell } from '../components/task-artifacts'
import type { TaskArtifact, TaskArtifactProjection, TaskLog } from '../types'

const getTaskArtifacts = vi.hoisted(() =>
  vi.fn<(taskId: string) => Promise<TaskArtifactProjection>>()
)

vi.mock('../api', () => ({ getTaskArtifacts }))

const contentUrl = `https://media.example.com/v1/tasks/task-public/artifacts/image-0/content?access=${'A'.repeat(41)}-_`

function taskFixture(): TaskLog {
  return {
    id: 1,
    user_id: 7,
    platform: 'openrouter',
    task_id: 'task-public',
    action: 'generate',
    channel_id: 3,
    group: 'default',
    quota: 100,
    submit_time: 1,
    status: 'SUCCESS',
    admin_info: {
      task_plugin: {
        key: 'openrouter-video',
        name: 'OpenRouter Video',
        version: '1.0.0',
      },
    },
  }
}

async function openArtifacts(artifact: TaskArtifact) {
  getTaskArtifacts.mockResolvedValue({ artifacts: [artifact] })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <TaskArtifactsCell log={taskFixture()} />
    </QueryClientProvider>
  )
  await userEvent.click(screen.getByRole('button', { name: /artifacts/i }))
  await waitFor(() => expect(getTaskArtifacts).toHaveBeenCalled())
}

afterEach(() => {
  cleanup()
  getTaskArtifacts.mockReset()
})

it('offers a download for an artifact whose stored copy is still available', async () => {
  await openArtifacts({ key: 'image-0', type: 'image', content_url: contentUrl })

  // The Button renders as an anchor but keeps role="button".
  expect(
    await screen.findByRole('button', { name: /download/i })
  ).toHaveAttribute('href', contentUrl)
  expect(screen.queryByText(/no longer available/i)).not.toBeInTheDocument()
})

it('reports a deleted artifact as gone instead of offering a retry', async () => {
  await openArtifacts({
    key: 'image-0',
    type: 'image',
    content_url: contentUrl,
    gone: true,
  })

  expect(await screen.findByText(/no longer available/i)).toBeInTheDocument()
  // Retrying cannot restore a deleted copy, and downloading it would fail the
  // same way, so neither action may be offered.
  expect(
    screen.queryByRole('button', { name: /retry/i })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /download/i })
  ).not.toBeInTheDocument()
})
