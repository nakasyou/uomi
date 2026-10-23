import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { speakerLabel } from '../src/speaker-label.ts'
import { validateSegments } from '../worker/jobs.ts'

test('speaker display distinguishes omitted labels, unidentified speakers and overlapping known/unknown speakers', () => {
  assert.equal(speakerLabel(undefined), '')
  assert.equal(speakerLabel(null), 'Unknown speaker')
  assert.equal(speakerLabel('speaker_0'), 'speaker_0')
  assert.equal(speakerLabel('overlap:["speaker_0","speaker_1"]'), 'speaker_0 + speaker_1')
  assert.equal(speakerLabel('overlap:[null,"speaker_1"]'), 'Unknown speaker + speaker_1')
})

test('malformed, ambiguous and non-set overlap encodings remain exact literal labels', () => {
  for (const value of [
    'overlap:',
    'overlap:["speaker_0",',
    'overlap:null',
    'overlap:"speaker_0"',
    'overlap:[]',
    'overlap:["speaker_0"]',
    'overlap:[null,null]',
    'overlap:["speaker_0","speaker_0"]',
    'overlap:["speaker_0",42]',
    'overlap:["speaker_0",{}]',
    'overlap:["speaker_0",""]',
    'overlap:["speaker_0","  "]',
    'Overlap:["a","b"]',
    'speaker_0 + speaker_1',
    'null',
    'overlap:' + JSON.stringify(['a'.repeat(190), 'b']),
  ])
    assert.equal(speakerLabel(value), value)
})

test('formatting never recursively reinterprets IDs or creates a new identity from a display collision', () => {
  const nested = 'overlap:["a","b"]'
  const composite = 'overlap:' + JSON.stringify([nested, 'c'])
  assert.equal(speakerLabel(composite), nested + ' + c')
  const inputs = ['a + b', 'overlap:["a","b"]', 'Unknown speaker', null]
  assert.equal(speakerLabel(inputs[0]), speakerLabel(inputs[1]))
  assert.equal(speakerLabel(inputs[2]), speakerLabel(inputs[3]))
  assert.deepEqual(inputs, ['a + b', 'overlap:["a","b"]', 'Unknown speaker', null])
  assert.equal(new Set(inputs).size, 4)
})

test('speaker names containing HTML and JSON punctuation remain escaped text through the React renderer', () => {
  const name = '<img src=x onerror=alert(1)>'
  const raw = 'overlap:' + JSON.stringify([name, 'speaker "quoted" + literal'])
  const display = speakerLabel(raw)
  assert.equal(display, name + ' + speaker "quoted" + literal')
  const markup = renderToStaticMarkup(createElement('strong', null, display))
  assert.ok(markup.includes('&lt;img'))
  assert.ok(markup.includes('&quot;quoted&quot;'))
  assert.ok(!markup.includes('<img'))
})

test('existing segment API preserves raw composite/null speaker identity and its 200-character boundary', () => {
  const raw = 'overlap:[null,"speaker_0"]'
  const segments = [
    { start_ms: 0, end_ms: 20, text: 'first', speaker: raw },
    { start_ms: 20, end_ms: 40, text: 'second', speaker: null },
    { start_ms: 40, end_ms: 60, text: 'third', speaker: 'x'.repeat(200) },
  ]
  assert.deepEqual(validateSegments(segments, 60), segments)
  assert.equal(segments[0].speaker, raw)
  assert.throws(
    () => validateSegments([{ ...segments[0], speaker: 'x'.repeat(201) }], 60),
    /optional speaker/,
  )
})
