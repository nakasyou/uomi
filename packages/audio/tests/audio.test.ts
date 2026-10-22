import { expect, test } from 'bun:test'
import { oggOpus, oggFrames, stripSyntheticGaps } from '../src/index'
const frame = (id: string, data = '+P/+') => ({ id, data, durationMs: 20, offsetMs: 0 })
test('removing artificial silence preserves original encoded packets', () => {
  const source = [frame('a'), frame('b', '+P/9')]
  const audio = oggOpus([source[0], frame('silence'), frame('silence2'), source[1]])
  const clean = stripSyntheticGaps(audio, [{ beforeFrame: 1, durationMs: 40 }], 2)
  expect(oggFrames(clean).map((v) => v.data)).toEqual(source.map((v) => v.data))
  expect(stripSyntheticGaps(audio, [], 4)).toBe(audio)
  expect(() => stripSyntheticGaps(audio, [{ beforeFrame: 1, durationMs: 30 }], 2)).toThrow()
  expect(() => stripSyntheticGaps(audio, [{ beforeFrame: 1, durationMs: 20 }], 2)).toThrow()
})
