import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { END_MARKER, SKIP_MARKER, START_MARKER } from '../src/body/markers'
import { codeSpan, stripMarkerShapedComments } from '../src/markdown'

/**
 * The two primitives every untrusted field passes through. Both callers — the
 * commit subject renderer and the author resolver — have their own suites that
 * assert the FIELD they produce; what is pinned here is the rule itself, at the
 * edges neither caller happens to exercise.
 *
 * The code span is not a style choice. It replaced a backslash escape that was
 * measured against live GitHub and found not to stop the closing-keyword pass, so
 * a test that only checked "renders as text" would pass on the broken version too.
 * The properties below are the ones that survive that lesson: nothing in the
 * content can terminate the span, and the original text is recoverable from it.
 */

/** The reverse of {@link codeSpan}, following GFM's own unwrapping rules. */
function unwrap(rendered: string): string {
  const fence = /^`+/.exec(rendered)?.[0] ?? ''
  expect(rendered.endsWith(fence)).toBe(true)
  expect(rendered.length).toBeGreaterThan(fence.length * 2)

  const inner = rendered.slice(fence.length, rendered.length - fence.length)
  return inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== ''
    ? inner.slice(1, -1)
    : inner
}

describe('codeSpan', () => {
  it('wraps ordinary content in a single backtick', () => {
    expect(codeSpan('plain text')).toBe('`plain text`')
  })

  it('fences one backtick longer than the longest run inside', () => {
    expect(codeSpan('a `b` c')).toBe('``a `b` c``')
    expect(codeSpan('a ``b`` c')).toBe('```a ``b`` c```')
    expect(codeSpan('```')).toBe('```` ``` ````')
  })

  it('measures the LONGEST run, not the first one', () => {
    // A fence chosen from the first run would be closed by the second. This
    // content also ends on a backtick, so it is padded as well — the two rules
    // are independent and both apply here.
    expect(codeSpan('a `b` and ``c``')).toBe('``` a `b` and ``c`` ```')
  })

  it('pads both ends when either end is a backtick', () => {
    expect(codeSpan('`leading')).toBe('`` `leading ``')
    expect(codeSpan('trailing`')).toBe('`` trailing` ``')
    expect(codeSpan('`both`')).toBe('`` `both` ``')
  })

  it('does not pad when neither end is a backtick', () => {
    // Padding costs two characters in a budgeted body, so it is not applied
    // unconditionally.
    expect(codeSpan('a`b')).toBe('``a`b``')
  })

  it('adds no backslash, whatever the content', () => {
    for (const content of ['#12', '@alice', 'a|b', '<b>', '*em*', 'C:\\temp']) {
      expect(codeSpan(content)).toBe(`\`${content}\``)
    }
  })

  it.each([
    'plain text',
    'a `b` c',
    'a ``b`` c',
    '```',
    '`leading',
    'trailing`',
    '`both`',
    'fixes #12',
    'C:\\temp\\path',
    '`',
  ])('round-trips %s back to the original', (content) => {
    expect(unwrap(codeSpan(content))).toBe(content)
  })
})

describe('stripMarkerShapedComments', () => {
  it.each([START_MARKER, END_MARKER, SKIP_MARKER])('removes %s', (marker) => {
    expect(stripMarkerShapedComments(`before ${marker} after`)).toBe('before  after')
  })

  it('removes a marker-shaped comment whose name it has never seen', () => {
    expect(stripMarkerShapedComments('a <!-- pr-decorator:invented -->b')).toBe('a b')
  })

  it('strips to a fixed point, so removal cannot assemble a new marker', () => {
    // One pass leaves a genuine skip marker behind: the outer text closes over
    // the gap the inner comment left.
    const nested = '<!-- pr-<!-- pr-decorator:x -->decorator:skip -->'
    expect(stripMarkerShapedComments(nested)).toBe('')
  })

  it('does not swallow the text between two markers', () => {
    expect(stripMarkerShapedComments(`a ${START_MARKER} keep ${END_MARKER} b`)).toBe('a  keep  b')
  })

  it('leaves an unrelated HTML comment alone', () => {
    expect(stripMarkerShapedComments('a <!-- note --> b')).toBe('a <!-- note --> b')
  })

  it('leaves text with no marker byte-identical', () => {
    expect(stripMarkerShapedComments('nothing to do here')).toBe('nothing to do here')
  })
})

describe('module boundaries', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/markdown.ts', import.meta.url)), 'utf8')

  it('reads the source it is asserting over', () => {
    expect(source).toContain('export function codeSpan')
  })

  it('takes the marker literal from the module that owns it', () => {
    // Retyping a marker is the failure mode that orphans a pull request body
    // permanently, so the text must arrive by import.
    expect(source).toContain("from './body/markers'")
    expect(source).not.toContain('pr-decorator:start')
    expect(source).not.toContain('pr-decorator:end')
    expect(source).not.toContain('pr-decorator:skip')
  })

  it('stays a pure string module, with no API and no toolkit', () => {
    expect(source).not.toContain('@actions')
    expect(source).not.toContain('octokit')
  })
})
