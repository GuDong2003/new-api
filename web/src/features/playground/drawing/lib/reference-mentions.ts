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
*/

// `@2 (name)` names the second image of the request; `@? (name)` is a mention
// whose image is no longer among the references.
const REFERENCE_MENTION = /@([1-9]\d*|\?) \(/g

type ReferenceMention = {
  label: string
  start: number
  nameStart: number
}

export function formatReferenceMention(index: number, name: string): string {
  return `@${index + 1} (${name})`
}

// Reads the prompt's mentions in order. Each parenthesised name is skipped as
// a whole, so a name that itself reads like a mention is not taken for one; a
// name that never closes skips nothing.
function readReferenceMentions(prompt: string): ReferenceMention[] {
  const mentions: ReferenceMention[] = []
  let end = 0
  for (const match of prompt.matchAll(REFERENCE_MENTION)) {
    if (match.index < end) continue
    const nameStart = match.index + match[0].length
    end = nameStart
    let depth = 1
    for (let index = nameStart; index < prompt.length; index++) {
      if (prompt[index] === '(') depth++
      if (prompt[index] === ')') depth--
      if (depth === 0) {
        end = index + 1
        break
      }
    }
    mentions.push({ label: match[1], start: match.index, nameStart })
  }
  return mentions
}

/**
 * Carries the prompt's mentions over to a new reference order, since a request
 * numbers its references by their position. A mention follows the image its
 * number names, never a name: images from one model share one. The mention of
 * an image that left becomes `@?` and stays so, because nothing then says
 * which image it named.
 */
export function renumberReferenceMentions(
  prompt: string,
  previous: readonly string[],
  next: readonly string[]
): string {
  if (!prompt.includes('@')) return prompt
  let result = ''
  let copied = 0
  for (const mention of readReferenceMentions(prompt)) {
    const id = previous[Number(mention.label) - 1]
    if (mention.label === '?' || id === undefined) continue
    const position = next.indexOf(id)
    const label = position < 0 ? '?' : String(position + 1)
    result += `${prompt.slice(copied, mention.start)}@${label} (`
    copied = mention.nameStart
  }
  return result + prompt.slice(copied)
}

/**
 * Whether every mention names an image the request sends. An unbound mention,
 * or a number past the last reference, would point the model at a picture it
 * never receives.
 */
export function mentionsOnlySentReferences(
  prompt: string,
  count: number
): boolean {
  return readReferenceMentions(prompt).every(
    (mention) => mention.label !== '?' && Number(mention.label) <= count
  )
}
