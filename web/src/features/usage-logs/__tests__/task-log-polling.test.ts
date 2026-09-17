/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/
import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { shouldPollTaskLogs } from '../lib/task-logs'
import type { TaskLog } from '../types'

function task(status: TaskLog['status']): TaskLog {
  return {
    id: 1,
    user_id: 7,
    platform: 'image',
    task_id: 'task_image',
    action: 'image_generation',
    channel_id: 3,
    group: 'default',
    quota: 0,
    submit_time: 1,
    status,
  }
}

describe('task log polling', () => {
  test('polls while an image task is still running', () => {
    assert.equal(shouldPollTaskLogs([task('IN_PROGRESS')]), true)
  })

  test('stops polling after the task reaches a terminal status', () => {
    assert.equal(shouldPollTaskLogs([task('SUCCESS'), task('FAILURE')]), false)
  })
})
