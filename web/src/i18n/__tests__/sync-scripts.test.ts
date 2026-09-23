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
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, expect, it } from 'vitest'

const scripts = path.resolve(process.cwd(), 'scripts')
let fixtureDir: string | undefined

const originals = {
  en: '{\n  "translation": {\n    "Apple": "First",\n    "Apple": "Latest",\n    "Zulu": "Zulu"\n  }\n}\n',
  zh: '{\n  "translation": {\n    "Apple": "苹果",\n    "Zulu": "祖鲁"\n  }\n}\n',
  fr: '{"translation":{"Apple":"Pomme","Zulu":"Zulu"}}\n',
}

async function createFixture() {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'newapi-i18n-test-'))
  const localesDir = path.join(fixtureDir, 'src/i18n/locales')
  await mkdir(localesDir, { recursive: true })
  for (const [locale, contents] of Object.entries(originals)) {
    await writeFile(path.join(localesDir, `${locale}.json`), contents)
  }
  return localesDir
}

afterEach(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
  fixtureDir = undefined
})

it('reports only active languages without rewriting existing or archived translations', async () => {
  const localesDir = await createFixture()
  const result = spawnSync(
    process.execPath,
    [path.join(scripts, 'sync-i18n.mjs')],
    {
      cwd: fixtureDir,
      encoding: 'utf8',
    }
  )

  expect(result.status).toBe(0)
  for (const [locale, contents] of Object.entries(originals)) {
    expect(
      await readFile(path.join(localesDir, `${locale}.json`), 'utf8')
    ).toBe(contents)
  }
  const report = JSON.parse(
    await readFile(path.join(localesDir, '_reports/_sync-report.json'), 'utf8')
  )
  expect(Object.keys(report.locales)).toEqual(['en', 'zh'])
})

it('adds a new key only to English and Chinese without changing any existing values', async () => {
  const localesDir = await createFixture()
  const input = path.join(fixtureDir as string, 'translations.json')
  await writeFile(
    input,
    JSON.stringify({ en: { Beta: 'Beta' }, zh: { Beta: '贝塔' } })
  )

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync(
      process.execPath,
      [path.join(scripts, 'add-missing-keys.mjs'), input],
      { cwd: fixtureDir, encoding: 'utf8' }
    )
    expect(result.status).toBe(0)
  }

  const en = await readFile(path.join(localesDir, 'en.json'), 'utf8')
  const zh = await readFile(path.join(localesDir, 'zh.json'), 'utf8')
  expect(en.replace('    "Beta": "Beta",\n', '')).toBe(originals.en)
  expect(zh.replace('    "Beta": "贝塔",\n', '')).toBe(originals.zh)
  expect(JSON.parse(en).translation.Beta).toBe('Beta')
  expect(JSON.parse(zh).translation.Beta).toBe('贝塔')
  expect(await readFile(path.join(localesDir, 'fr.json'), 'utf8')).toBe(
    originals.fr
  )
})
