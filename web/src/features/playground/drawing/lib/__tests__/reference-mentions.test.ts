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
import { describe, expect, it } from 'vitest'

import {
  formatReferenceMention,
  mentionsOnlySentReferences,
  renumberReferenceMentions,
} from '../reference-mentions'

describe('Reference prompt mentions', () => {
  it('includes the current reference number and filename', () => {
    expect(formatReferenceMention(1, '狐狸.png')).toBe('@2 (狐狸.png)')
  })

  it('renumbers mentions to follow reordered references', () => {
    expect(
      renumberReferenceMentions(
        '把@2 (B.png)的角色放进@1 (A.png)',
        ['a', 'b'],
        ['b', 'a']
      )
    ).toBe('把@1 (B.png)的角色放进@2 (A.png)')
  })

  // Images from one model share a name, so only the number says which image
  // a mention names.
  it('follows each mention by its number when references share a name', () => {
    expect(
      renumberReferenceMentions(
        '@1 (gpt-image-2-1) 换成 @2 (gpt-image-2-1)',
        ['first', 'second'],
        ['second', 'first']
      )
    ).toBe('@2 (gpt-image-2-1) 换成 @1 (gpt-image-2-1)')
  })

  it('unbinds the mention of a removed reference and shifts the ones after it', () => {
    expect(
      renumberReferenceMentions(
        '@1 (A.png) @2 (B.png) @3 (C.png)',
        ['a', 'b', 'c'],
        ['a', 'c']
      )
    ).toBe('@1 (A.png) @? (B.png) @2 (C.png)')
  })

  // An unbound mention no longer says which image it named; binding it to an
  // image that comes back would be a guess.
  it('keeps an unbound mention unbound when images come back', () => {
    expect(
      renumberReferenceMentions(
        '@? (B.png) 和 @2 (C.png)',
        ['a', 'c'],
        ['a', 'b', 'c']
      )
    ).toBe('@? (B.png) 和 @3 (C.png)')
  })

  it('leaves text that mentions no listed reference unchanged', () => {
    const prompt =
      '@5 (Z.png) 发给 me@example.com，@0 (x) 与 @01 (y) 也不是提及'

    expect(renumberReferenceMentions(prompt, ['a', 'b'], ['b', 'a'])).toBe(
      prompt
    )
  })

  it('leaves a name that reads like a mention untouched inside its mention', () => {
    expect(
      renumberReferenceMentions(
        '@1 (IMG @2 (1).png) 和 @2 (B.png)',
        ['odd', 'b'],
        ['b', 'odd']
      )
    ).toBe('@2 (IMG @2 (1).png) 和 @1 (B.png)')
    expect(mentionsOnlySentReferences('@1 (IMG @2 (1).png)', 1)).toBe(true)
  })

  it('accepts mentions of the references a request sends', () => {
    expect(mentionsOnlySentReferences('@1 (A.png) 和 @2 (B.png)', 2)).toBe(true)
    expect(mentionsOnlySentReferences('no mentions here, @0 (x)', 0)).toBe(true)
  })

  it('rejects an unbound mention or a number past the references a request sends', () => {
    expect(mentionsOnlySentReferences('@? (B.png)', 2)).toBe(false)
    expect(mentionsOnlySentReferences('@3 (C.png)', 2)).toBe(false)
    expect(mentionsOnlySentReferences('@1 (A.png)', 0)).toBe(false)
  })
})
