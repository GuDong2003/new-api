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
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { Window } from 'happy-dom'

import type { InviteCode } from '../types'

const domWindow = new Window()
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLButtonElement',
  'SVGElement',
  'Node',
  'Element',
  'Event',
  'MouseEvent',
  'PointerEvent',
  'CustomEvent',
  'MutationObserver',
  'ResizeObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: domWindow[key],
  })
}

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createInstance } = await import('i18next')
const { I18nextProvider, initReactI18next } = await import('react-i18next')
const { InviteCodeRowActions } = await import('../invite-code-row-actions')

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        Delete: 'Delete',
        Edit: 'Edit',
        'Delete Invitation Code': 'Delete Invitation Code',
        'Used invitation codes cannot be deleted. Disable them instead.':
          'Used invitation codes cannot be deleted. Disable them instead.',
      },
    },
  },
})

const reactTestGlobals = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
reactTestGlobals.IS_REACT_ACT_ENVIRONMENT = true

const baseInviteCode: InviteCode = {
  id: 1,
  code_prefix: 'NAPI-ABCD',
  code: 'NAPI-ABCD-EFGH-JKLM-NPQR',
  code_available: true,
  name: 'early access',
  status: 1,
  max_uses: 1,
  used_count: 0,
  created_by: 1,
  created_time: 1,
  updated_time: 1,
  expired_time: 0,
}

async function renderActions(inviteCode: InviteCode, onDelete: () => void) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <InviteCodeRowActions
          inviteCode={inviteCode}
          onEdit={() => undefined}
          onDelete={onDelete}
        />
      </I18nextProvider>
    )
  })
  return { container, root }
}

function getDeleteButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes('Delete')
  )
  assert.ok(button)
  return button
}

after(() => {
  domWindow.close()
})

test('unused invitation code exposes an enabled destructive action', async () => {
  let deleteCount = 0
  const rendered = await renderActions(baseInviteCode, () => {
    deleteCount += 1
  })
  const deleteButton = getDeleteButton(rendered.container)

  assert.equal(deleteButton.disabled, false)
  assert.equal(
    deleteButton.getAttribute('aria-label'),
    'Delete Invitation Code'
  )
  await act(async () => deleteButton.click())
  assert.equal(deleteCount, 1)

  await act(async () => rendered.root.unmount())
  rendered.container.remove()
})

test('used invitation code keeps delete disabled and explains the fallback', async () => {
  let deleteCount = 0
  const rendered = await renderActions(
    { ...baseInviteCode, used_count: 1 },
    () => {
      deleteCount += 1
    }
  )
  const deleteButton = getDeleteButton(rendered.container)

  assert.equal(deleteButton.disabled, true)
  assert.equal(
    deleteButton.getAttribute('aria-label'),
    'Used invitation codes cannot be deleted. Disable them instead.'
  )
  await act(async () => deleteButton.click())
  assert.equal(deleteCount, 0)

  await act(async () => rendered.root.unmount())
  rendered.container.remove()
})
