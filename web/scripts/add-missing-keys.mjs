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
import fs from 'node:fs/promises'
import path from 'node:path'

const localesDir = path.resolve('src/i18n/locales')
const languages = ['en', 'zh']
const entryPattern = /^ {4}("(?:\\.|[^"\\])*"): "(?:\\.|[^"\\])*"(,?)$/

function placeholders(value) {
  return [
    ...new Set(
      [...value.matchAll(/{{\s*([\w.-]+)\s*}}/g)].map((match) => match[1])
    ),
  ].sort()
}

function addKeys(source, additions) {
  const current = JSON.parse(source).translation
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('Expected a flat translation object')
  }
  const lines = source.split('\n')
  const opening = lines.indexOf('  "translation": {')
  if (opening < 0) {
    throw new Error('Expected a four-space indented translation object')
  }

  for (const [key, value] of Object.entries(additions).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (Object.hasOwn(current, key)) {
      if (current[key] !== value) {
        throw new Error(`Existing translation differs: ${key}`)
      }
      continue
    }
    const closing = lines.findIndex(
      (line, index) => index > opening && line === '  }'
    )
    if (closing < 0) {
      throw new Error('Expected a flat translation object')
    }
    const existing = lines.slice(opening + 1, closing).map((line) => {
      const entry = line.match(entryPattern)
      if (!entry) {
        throw new Error(
          'Unexpected translation formatting; refusing to rewrite it'
        )
      }
      return JSON.parse(entry[1])
    })
    const before = existing.findIndex((oldKey) => oldKey.localeCompare(key) > 0)
    const newLine = `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`
    if (before >= 0) {
      lines.splice(opening + before + 1, 0, `${newLine},`)
    } else {
      if (existing.length > 0) {
        lines[closing - 1] += ','
      }
      lines.splice(closing, 0, newLine)
    }
    current[key] = value
  }
  const result = lines.join('\n')
  JSON.parse(result)
  return result
}

async function main() {
  const inputFile = process.argv[2]
  if (!inputFile || process.argv.length !== 3) {
    throw new Error(
      'Usage: node scripts/add-missing-keys.mjs <translations.json>'
    )
  }
  const additions = JSON.parse(await fs.readFile(inputFile, 'utf8'))
  if (
    !additions ||
    Object.keys(additions).sort().join(',') !== 'en,zh' ||
    !additions.en ||
    !additions.zh
  ) {
    throw new Error('Provide matching en and zh translation objects')
  }
  const keys = Object.keys(additions.en).sort()
  if (keys.join('\n') !== Object.keys(additions.zh).sort().join('\n')) {
    throw new Error('English and Chinese keys must match')
  }
  for (const key of keys) {
    const en = additions.en[key]
    const zh = additions.zh[key]
    if (
      typeof en !== 'string' ||
      en !== key ||
      typeof zh !== 'string' ||
      !zh.trim()
    ) {
      throw new Error(`Invalid translation for ${key}`)
    }
    if (placeholders(en).join(',') !== placeholders(zh).join(',')) {
      throw new Error(`Interpolation placeholders differ for ${key}`)
    }
  }

  // Prepare both changes before writing either file, so an invalid value or
  // unexpected locale layout never leaves a partial update.
  const updates = await Promise.all(
    languages.map(async (language) => {
      const filename = path.join(localesDir, `${language}.json`)
      const source = await fs.readFile(filename, 'utf8')
      return { filename, source, next: addKeys(source, additions[language]) }
    })
  )
  for (const { filename, source, next } of updates) {
    if (source !== next) {
      await fs.writeFile(filename, next, 'utf8')
    }
  }
  console.log(`Applied ${keys.length} English/Chinese translation keys`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
