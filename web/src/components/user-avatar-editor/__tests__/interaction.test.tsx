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

const domWindow = new Window()
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
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
const { UserAvatarEditor } = await import('../../user-avatar-editor')

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        'Change Avatar': 'Change Avatar',
        'Change or remove avatar': 'Change or remove avatar',
        "{{name}}'s avatar": "{{name}}'s avatar",
      },
    },
  },
})

const reactTestGlobals = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
reactTestGlobals.IS_REACT_ACT_ENVIRONMENT = true

async function renderEditor(avatarUrl?: string, compact = true) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <UserAvatarEditor
          compact={compact}
          name='alice'
          avatarUrl={avatarUrl}
        />
      </I18nextProvider>
    )
  })
  return { container, root }
}

after(() => {
  domWindow.close()
})

test('avatar editor trigger stays keyboard-accessible without a custom image', async () => {
  const rendered = await renderEditor()
  const trigger = rendered.container.querySelector('button')

  assert.ok(trigger)
  assert.equal(trigger.type, 'button')
  assert.equal(trigger.getAttribute('aria-label'), 'Change Avatar')
  assert.equal(rendered.container.querySelector('img'), null)
  assert.match(rendered.container.textContent || '', /A/)

  await act(async () => rendered.root.unmount())
  rendered.container.remove()
})

test('avatar editor exposes change and removal when an avatar URL exists', async () => {
  const rendered = await renderEditor(
    '/api/avatar/0123456789abcdef0123456789abcdef.svg',
    false
  )

  assert.match(rendered.container.textContent || '', /Change or remove avatar/)

  await act(async () => rendered.root.unmount())
  rendered.container.remove()
})
