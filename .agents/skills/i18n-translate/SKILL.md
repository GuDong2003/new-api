---
name: i18n-translate
description: >-
  Use when changing frontend locale files, adding or fixing translation keys,
  reviewing untranslated UI copy, or working with `t(...)`, `useTranslation()`,
  static i18n keys, labels, toasts, dialogs, placeholders, or validation text.
---

# Frontend i18n Translation Workflow

## Mandatory Preflight

- Read this entire `SKILL.md` before any frontend i18n work, including one-key fixes.
- Before editing locale files, confirm the source text comes from a `t(...)` key, `en.json`, existing UI copy, or an explicitly requested new UI string.
- Use the user conversation only to understand the task target. Do not copy conversation text, review wording, or task descriptions directly into locale values.
- Before translating each key, re-think the intended UI copy from the code and locale context instead of treating the surrounding chat as the translation source.

### Hard Constraint: Locale Writes Go Through the Script

- You MUST NOT edit `web/src/i18n/locales/*.json` directly with text-editing tools (StrReplace, Write, search-and-replace, manual JSON edits, etc.). This applies even to a single key.
- ALL locale writes MUST go through `web/scripts/add-missing-keys.mjs`, followed by `bun run i18n:sync`. The script adds only new keys; if an existing translation needs revision, stop and request a separate approved method instead of overwriting it.
- Why this is mandatory, not optional:
  - Hand-editing can silently drop or alter existing translations, duplicate keys, or protected metadata.
  - The script validates both active languages and interpolation placeholders, and inserts keys without rewriting existing entries or archived files.
- The script does not translate copy. Supply considered English and Simplified Chinese values in the input file.

## Scope Checklist

Before editing files, treat the task as covered by this skill if it involves:

- `i18n`, translation, locale files, language packs, missing keys, or untranslated text
- `t('...')`, `useTranslation()`, `static-keys.ts`, or `locales/*.json`
- UI copy in buttons, labels, toasts, dialogs, placeholders, validation messages, descriptions, or table/empty states
- A review finding about missing i18n keys

Do not skip this workflow because the fix is "just one key".

## Overview

- Maintained locale files: `web/src/i18n/locales/{en,zh}.json`. Existing `zh-TW`, `fr`, `ja`, `ru`, `vi` files are archives: keep them but do not load, modify, or add keys to them.
- Format: flat JSON under `"translation"` key, keys are English source strings
- Base locale: `en.json`; runtime fallback: English. Legacy Traditional Chinese preferences use `zhCN` (`zh.json`); other retired preferences use English.
- Sync script: `bun run i18n:sync` (from `web/`) reports on `en` and `zh` without rewriting locale files.
- All new `t()` keys must exist in both maintained locale files.

## Small Fix Path

For a single known missing key (still script-only, no direct JSON edits):

1. Confirm the exact key at the call site and check `en.json` and `zh.json` for an existing value.
2. Supply a JSON input with matching `en` and `zh` keys to `node scripts/add-missing-keys.mjs translations.json` from `web/`. Even one key goes through the script; do not hand-edit the JSON.
3. The script preserves existing values and formatting and inserts the new key in order.
4. Run a targeted search for the key in code and locale files.
5. Run `bun run i18n:sync` and review its report. It never normalizes or rewrites locale files.

## Workflow

### Step 1: Run sync and read report

```bash
cd web && bun run i18n:sync
```

Read `web/src/i18n/locales/_reports/_sync-report.json` to see per-locale status (missingCount, extrasCount, untranslatedCount).

### Step 2: Find missing keys (used in code but not in locale files)

Create and run `web/scripts/find-missing-keys.mjs`:

```javascript
import fs from 'node:fs/promises'
import path from 'node:path'

const LOCALES_DIR = path.resolve('src/i18n/locales')
const SRC_DIR = path.resolve('src')

const localeKeys = {}
for (const locale of ['en', 'zh']) {
  const json = JSON.parse(await fs.readFile(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'))
  localeKeys[locale] = new Set(Object.keys(json.translation))
}

const tCallRegex = /\bt\(\s*['"`]([^'"`\n]+?)['"`]\s*[,)]/g
const tCallMultilineRegex = /\bt\(\s*['"`]([^'"`]+?)['"`]\s*\)/g

async function walkDir(dir) {
  const files = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'locales', '_reports', '_extras'].includes(entry.name)) continue
      files.push(...(await walkDir(fullPath)))
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      files.push(fullPath)
    }
  }
  return files
}

const files = await walkDir(SRC_DIR)
const missingKeys = new Map()

for (const file of files) {
  const content = await fs.readFile(file, 'utf8')
  const relPath = path.relative(SRC_DIR, file)
  for (const regex of [tCallRegex, tCallMultilineRegex]) {
    regex.lastIndex = 0
    let match
    while ((match = regex.exec(content)) !== null) {
      const key = match[1]
      if (key.startsWith('{{') || key.includes('${')) continue
      const missingLocales = Object.keys(localeKeys).filter(locale => !localeKeys[locale].has(key))
      if (missingLocales.length) {
        if (!missingKeys.has(key)) missingKeys.set(key, [])
        missingKeys.get(key).push(`${relPath} (missing: ${missingLocales.join(', ')})`)
      }
    }
  }
}

if (missingKeys.size === 0) {
  console.log('All t() keys found in en.json and zh.json!')
} else {
  console.log(`Found ${missingKeys.size} missing keys:\n`)
  for (const [key, files] of [...missingKeys.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  "${key}"`)
    for (const f of [...new Set(files)]) console.log(`    -> ${f}`)
  }
}
```

### Step 3: Find untranslated entries (value equals English)

Create and run `web/scripts/find-untranslated.mjs`:

```javascript
import fs from 'node:fs/promises'
import path from 'node:path'

const LOCALES_DIR = path.resolve('src/i18n/locales')
const en = JSON.parse(await fs.readFile(path.join(LOCALES_DIR, 'en.json'), 'utf8'))
const enTrans = en.translation

// Brand names, URLs, technical terms — skip these
const skipPatterns = [
  /^https?:\/\//, /^smtp\./, /^socks5:/, /^name@/, /^noreply@/,
  /^org-/, /^price_/, /^whsec_/, /^edit_this$/, /^my-status$/,
  /^_copy$/, /^gpt-/, /^checkout\./, /^footer\./, /^\[?\{/,
  /^"default/, /^\/status\//, /^\/your\//, /^example\.com/,
  /^AZURE_/, /^AccessKey/, /^OAuth/, /^Client /, /^Webhook URL/,
  /^API URL$/, /^Well-Known/, /^Worker URL$/, /^Uptime Kuma/,
  /^New API/, /^Baidu V2$/, /^Zhipu V4$/, /^Quota:$/,
]

const brandNames = new Set([
  'AIGC2D','Anthropic','API2GPT','Claude','Cloudflare','Cohere','DeepSeek',
  'Discord','DoubaoVideo','FastGPT','Gemini','GitHub','Jimeng','JustSong',
  'LingYiWanWu','LinuxDO','Midjourney','MidjourneyPlus','MiniMax','Mistral',
  'MokaAI','Moonshot','NewAPI','OhMyGPT','Ollama','OpenAI','OpenAIMax',
  'OpenRouter','Passkey','Perplexity','QuantumNous','Replicate','SiliconFlow',
  'Stripe','Submodel','SunoAPI','Telegram','Tencent','Vertex AI','VolcEngine',
  'WeChat','Xinference','Xunfei','AI Proxy','One API',
])

const locales = ['zh']

for (const locale of locales) {
  const locFile = JSON.parse(await fs.readFile(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'))
  const locTrans = locFile.translation
  const untranslated = {}

  for (const [key, enVal] of Object.entries(enTrans)) {
    const locVal = locTrans[key]
    if (locVal === undefined || locVal !== enVal) continue
    if (brandNames.has(key)) continue
    if (skipPatterns.some(p => p.test(key))) continue
    if (typeof enVal === 'string' && enVal.length < 4) continue
    if (/[a-zA-Z]{3,}/.test(String(enVal))) untranslated[key] = enVal
  }

  const count = Object.keys(untranslated).length
  if (count > 0) {
    console.log(`\n=== ${locale} (${count} untranslated) ===`)
    for (const [k, v] of Object.entries(untranslated))
      console.log(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
  } else {
    console.log(`\n=== ${locale}: all translated ===`)
  }
}
```

### Step 4: Add translations

Use the existing `web/scripts/add-missing-keys.mjs` for new keys only. Supply a JSON file with matching keys for both active languages; for example:

```json
{
  "en": { "Generate image": "Generate image" },
  "zh": { "Generate image": "生成图片" }
}
```

Run `node scripts/add-missing-keys.mjs translations.json` from `web/`. The script rejects conflicting existing values and mismatched interpolation placeholders. Never replace this script with a whole-file JSON serializer: archived translations, existing values, duplicate keys, and formatting must remain untouched.

### Step 5: Verify and clean up

```bash
cd web
node scripts/add-missing-keys.mjs translations.json    # add new keys to en and zh
node scripts/find-missing-keys.mjs                      # verify both active locales
bun run i18n:sync                                       # generate report only
```

Delete temporary scripts after completion.

## Translation Guidelines

### Source Text Rules

- Reconsider every key's UI meaning before translating: component location, user action, placeholder variables, button/label/toast/dialog/validation context, and whether the copy is a noun, command, status, or full sentence.
- Prefer the English key or `en` value as the source text. Use the call site only to clarify meaning, tone, and constraints.
- Do not copy chat messages, review comments, issue descriptions, or task wording as translation text.
- If the source text is unclear, inspect the code and locale files first. Ask the user for exact source copy only when the intended UI text remains ambiguous.

### Length and Layout Awareness

- Consider whether translated text may overflow the UI before choosing final wording, especially for buttons, table headers, menu items, labels, toasts, dialog titles, tabs, badges, and empty states.
- Chinese text may be shorter or longer than English; prefer natural but compact wording where space is limited.
- Do not sacrifice meaning just to shorten text. When the call site has limited space, choose the shortest clear translation that preserves the UI intent.
- For interpolated variables, counts, model names, provider names, quotas, and dates, consider the longest realistic rendered text, not only the translation string itself.

| Language | Code | Notes |
|----------|------|-------|
| English | en | Base locale, key = value |
| Simplified Chinese | zh | Active Chinese locale; use natural Simplified Chinese wording |

**Keep as English (do not translate):**
- Brand/product names (OpenAI, Claude, Gemini, etc.)
- URLs and email placeholders
- Technical identifiers (JSON keys, API paths, model names)
- Code-like strings (gpt-3.5-turbo, price_xxx, etc.)

**Always translate:**
- UI labels, button text, error messages, descriptions
- Time units (hours, minutes, months, years)
- Action words (Move, Show, Delete, etc.)

## Key Rules

1. All scripts run from `web/` directory
2. Use `node scripts/xxx.mjs` (ESM format with top-level await)
3. Sort keys alphabetically when writing locale files
4. Always run `bun run i18n:sync` to review the read-only report after adding translations
5. Delete temporary scripts after completion
6. The `{{variable}}` placeholders in keys must be preserved in all translations
7. NEVER edit `locales/*.json` directly. Any non-script write to a locale file (StrReplace, Write, manual JSON edit) is non-compliant, including single-key fixes.
