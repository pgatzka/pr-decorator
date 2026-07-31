import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

import { DecoratorError } from '../src/errors'
import { capBranchName, MAX_BRANCH_NAME_LENGTH, parseInputs } from '../src/inputs'
import type { DecoratorInputs } from '../src/types'

/**
 * `parseInputs` is pure apart from reading `process.env`, so the whole suite
 * drives it by setting `INPUT_*` variables directly — no Octokit, no network and
 * no runner. What is worth pinning is the validation matrix itself, plus three
 * things that are easy to get subtly wrong: the environment variable names the
 * toolkit actually reads, the defaults staying in step with `action.yml`, and the
 * `timezone` message wording, which a workflow step asserts on.
 */

/**
 * The toolkit's own mapping: uppercase, spaces to underscores, and hyphens left
 * alone. So `branch-pattern` is read from `INPUT_BRANCH-PATTERN` — NOT from
 * `INPUT_BRANCH_PATTERN`, which the runner never sets and nothing here reads.
 */
function envName(input: string): string {
  return `INPUT_${input.replace(/ /g, '_').toUpperCase()}`
}

/** A token is always present in a real run; `action.yml` defaults it. */
const BASE_INPUTS: Record<string, string> = {
  timezone: 'Europe/Berlin',
  token: 'ghs_test',
}

function setInputs(inputs: Record<string, string>): void {
  for (const [name, value] of Object.entries(inputs)) {
    process.env[envName(name)] = value
  }
}

/** Parses with the base inputs plus `inputs`, which may override or unset them. */
function parseWith(inputs: Record<string, string | undefined> = {}): DecoratorInputs {
  setInputs(BASE_INPUTS)
  for (const [name, value] of Object.entries(inputs)) {
    if (value === undefined) {
      delete process.env[envName(name)]
    } else {
      process.env[envName(name)] = value
    }
  }
  return parseInputs()
}

/** Asserts the call raises a fatal `DecoratorError` and hands it back. */
function expectFatal(run: () => unknown): DecoratorError {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught, 'expected a DecoratorError, but the call returned').toBeInstanceOf(
    DecoratorError,
  )
  const error = caught as DecoratorError
  expect(error.severity).toBe('fatal')
  return error
}

beforeEach(() => {
  // The suite owns the whole INPUT_ namespace; a stray variable from the host or
  // from a previous case would make a default silently untested.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) {
      delete process.env[key]
    }
  }
})

describe('defaults', () => {
  it('returns the documented defaults when only timezone and token are set', () => {
    const inputs = parseWith()
    expect(inputs).toEqual({
      timezone: 'Europe/Berlin',
      token: 'ghs_test',
      position: 'top',
      issueLink: true,
      branchPattern: /^(\d+)-/,
      footer: true,
      mentions: 'login',
      dryRun: false,
    })
  })

  it('compiles the default branch-pattern with no flags', () => {
    const { branchPattern } = parseWith()
    expect(branchPattern.source).toBe(String.raw`^(\d+)-`)
    expect(branchPattern.flags).toBe('')
    expect(branchPattern.global).toBe(false)
    expect(branchPattern.sticky).toBe(false)
  })

  it('needs no INPUT_ variable but timezone and token to reach those defaults', () => {
    // The six optional inputs are defaulted here rather than relied upon from
    // action.yml, so that parseInputs() is correct however it is invoked. The
    // token is the one exception: it has no safe fallback, so an empty one is
    // fatal even though action.yml always supplies `${{ github.token }}`.
    setInputs(BASE_INPUTS)
    expect(
      Object.keys(process.env).filter((key) => key.startsWith('INPUT_')).sort(),
    ).toEqual(['INPUT_TIMEZONE', 'INPUT_TOKEN'])
    expect(() => parseInputs()).not.toThrow()
  })
})

describe('the defaults stay in step with action.yml', () => {
  interface ActionYml {
    inputs?: Record<string, { default?: string }>
  }

  const action = parse(
    readFileSync(fileURLToPath(new URL('../action.yml', import.meta.url)), 'utf8'),
  ) as ActionYml

  it.each([
    ['position', (parsed: DecoratorInputs) => parsed.position],
    ['issue-link', (parsed: DecoratorInputs) => String(parsed.issueLink)],
    ['branch-pattern', (parsed: DecoratorInputs) => parsed.branchPattern.source],
    ['footer', (parsed: DecoratorInputs) => String(parsed.footer)],
    ['mentions', (parsed: DecoratorInputs) => parsed.mentions],
    ['dry-run', (parsed: DecoratorInputs) => String(parsed.dryRun)],
  ])('falls back to the %s default declared in action.yml', (name, read) => {
    // The runner supplies these defaults in a real run and parseInputs repeats
    // them; drift between the two would be invisible in production and wrong
    // everywhere else.
    expect(read(parseWith())).toBe(action.inputs?.[name]?.default)
  })
})

describe('timezone', () => {
  it('accepts an IANA zone name', () => {
    expect(parseWith({ timezone: 'America/New_York' }).timezone).toBe('America/New_York')
  })

  it('trims surrounding whitespace', () => {
    expect(parseWith({ timezone: '  Europe/Berlin  ' }).timezone).toBe('Europe/Berlin')
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['an offset rather than a zone', 'UTC+2'],
    ['a zone that does not exist', 'Mars/Phobos'],
  ])('is fatal when it is %s', (_rule, value) => {
    const error = expectFatal(() => parseWith({ timezone: value }))
    // Pinned as a shared invariant: the pre-tag bundle smoke test asserts an
    // `::error::` line containing this token, so rewording the messages in
    // src/inputs.ts means updating that workflow step too.
    expect(error.message).toContain('timezone')
  })

  it('says so explicitly when the input is simply missing', () => {
    const error = expectFatal(() => parseWith({ timezone: undefined }))
    expect(error.message).toContain('required')
    expect(error.message).toContain('Europe/Berlin')
  })

  it('is checked before every other input, so its error wins', () => {
    const error = expectFatal(() =>
      parseWith({ timezone: undefined, token: '', position: 'middle', 'dry-run': 'maybe' }),
    )
    expect(error.message).toContain('timezone')
  })
})

describe('token', () => {
  it('passes a non-empty token through', () => {
    expect(parseWith({ token: 'ghp_example' }).token).toBe('ghp_example')
  })

  it.each([
    ['unset', undefined],
    ['empty', ''],
  ])('is fatal when it is %s', (_rule, value) => {
    const error = expectFatal(() => parseWith({ token: value }))
    expect(error.message).toContain('token')
  })
})

describe('booleans', () => {
  const BOOLEANS = ['issue-link', 'footer', 'dry-run'] as const
  const FIELDS = { 'issue-link': 'issueLink', footer: 'footer', 'dry-run': 'dryRun' } as const

  it.each(BOOLEANS)('parses %s as true', (name) => {
    expect(parseWith({ [name]: 'true' })[FIELDS[name]]).toBe(true)
  })

  it.each(BOOLEANS)('parses %s as false', (name) => {
    expect(parseWith({ [name]: 'false' })[FIELDS[name]]).toBe(false)
  })

  it.each(['true', 'True', 'TRUE'])('accepts the YAML spelling %s', (value) => {
    expect(parseWith({ 'dry-run': value }).dryRun).toBe(true)
  })

  it.each(['false', 'False', 'FALSE'])('accepts the YAML spelling %s', (value) => {
    expect(parseWith({ 'issue-link': value }).issueLink).toBe(false)
  })

  it.each(['yes', 'no', '1', '0', 'maybe', 'TrUe'])(
    'refuses %s, which YAML booleans do not include',
    (value) => {
      const error = expectFatal(() => parseWith({ 'dry-run': value }))
      expect(error.message).toContain('dry-run')
      expect(error.message).toContain('TRUE')
      expect(error.message).toContain(value)
    },
  )

  it.each(BOOLEANS)('names %s in its own error', (name) => {
    expect(expectFatal(() => parseWith({ [name]: 'maybe' })).message).toContain(name)
  })
})

describe('enums', () => {
  it.each(['top', 'bottom'] as const)('accepts position %s', (value) => {
    expect(parseWith({ position: value }).position).toBe(value)
  })

  it.each(['login', 'name'] as const)('accepts mentions %s', (value) => {
    expect(parseWith({ mentions: value }).mentions).toBe(value)
  })

  it('refuses a third position and lists the allowed values', () => {
    const error = expectFatal(() => parseWith({ position: 'middle' }))
    expect(error.message).toContain('position')
    expect(error.message).toContain('`top`')
    expect(error.message).toContain('`bottom`')
    expect(error.message).toContain('middle')
  })

  it('refuses a third mentions style and lists the allowed values', () => {
    const error = expectFatal(() => parseWith({ mentions: 'email' }))
    expect(error.message).toContain('mentions')
    expect(error.message).toContain('`login`')
    expect(error.message).toContain('`name`')
    expect(error.message).toContain('email')
  })

  it.each(['Top', 'BOTTOM'])('is case sensitive, refusing %s', (value) => {
    expectFatal(() => parseWith({ position: value }))
  })
})

describe('branch-pattern', () => {
  it('compiles a custom pattern with the number in a later position', () => {
    const { branchPattern } = parseWith({ 'branch-pattern': String.raw`^(?:feature|fix)/(\d+)-` })
    expect(branchPattern.exec('feature/77-thing')?.[1]).toBe('77')
  })

  it('never compiles a global or sticky pattern, whatever the source says', () => {
    // The input is a pattern SOURCE; flags cannot be supplied, so `lastIndex`
    // can never go stale between calls.
    const { branchPattern } = parseWith({ 'branch-pattern': String.raw`(\d+)-` })
    expect(branchPattern.flags).toBe('')
    expect(branchPattern.exec('x142-fix')?.[1]).toBe('142')
    expect(branchPattern.exec('x142-fix')?.[1]).toBe('142')
  })

  it('quotes the regex syntax error when the pattern does not compile', () => {
    const error = expectFatal(() => parseWith({ 'branch-pattern': '([' }))
    expect(error.message).toContain('branch-pattern')
    expect(error.message).toContain('([')
    // The underlying SyntaxError text, whatever V8 words it as.
    expect(error.message).toMatch(/character class|group|Invalid regular expression/i)
    expect(error.cause).toBeInstanceOf(SyntaxError)
  })

  it('is fatal when the pattern declares no capturing group', () => {
    const error = expectFatal(() => parseWith({ 'branch-pattern': String.raw`^issue-\d+` }))
    expect(error.message).toContain('branch-pattern')
    expect(error.message).toContain('capturing group')
  })

  it.each([
    ['a non-capturing group only', String.raw`^(?:\d+)-`],
    ['a lookahead only', String.raw`^(?=\d)\d+-`],
    ['an escaped parenthesis', String.raw`^\(\d+\)-`],
    ['a parenthesis inside a character class', String.raw`^[()]\d+-`],
  ])('counts structurally, so %s does not count as a group', (_rule, source) => {
    expectFatal(() => parseWith({ 'branch-pattern': source }))
  })

  it.each([
    ['a named group', String.raw`^(?<issue>\d+)-`],
    ['a group that cannot participate in a match', String.raw`^x(\d+)?-|^y-`],
    ['a group nested in a non-capturing one', String.raw`^(?:v(\d+))-`],
  ])('accepts %s, which trial matching would misjudge', (_rule, source) => {
    expect(parseWith({ 'branch-pattern': source }).branchPattern.source).toBe(source)
  })

  it('treats the branch name as data, never as pattern', () => {
    const { branchPattern } = parseWith()
    expect(branchPattern.exec('(.*)+-foo')).toBeNull()
  })
})

describe('capBranchName', () => {
  it('returns a normal branch name unchanged', () => {
    expect(capBranchName('142-fix-auth')).toBe('142-fix-auth')
  })

  it('returns the empty string unchanged rather than null', () => {
    expect(capBranchName('')).toBe('')
  })

  it('accepts a name of exactly the maximum length', () => {
    const name = 'a'.repeat(MAX_BRANCH_NAME_LENGTH)
    expect(capBranchName(name)).toBe(name)
  })

  it('refuses a name one character over the maximum', () => {
    expect(capBranchName('a'.repeat(MAX_BRANCH_NAME_LENGTH + 1))).toBeNull()
  })

  it('refuses a pathologically long name, whatever it starts with', () => {
    // The ReDoS bound: a user-supplied pattern must never meet an unbounded
    // subject, even one that begins with a perfectly ordinary issue number.
    expect(capBranchName(`142-${'a'.repeat(100_000)}`)).toBeNull()
  })

  it('bounds the subject to a length no backtracking pattern can exploit', () => {
    expect(MAX_BRANCH_NAME_LENGTH).toBeGreaterThan(0)
    expect(MAX_BRANCH_NAME_LENGTH).toBeLessThanOrEqual(1024)
  })
})

describe('module boundaries', () => {
  const srcRoot = fileURLToPath(new URL('../src/', import.meta.url))
  const sources = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' }).filter((entry) =>
    entry.endsWith('.ts'),
  )

  it('reads the sources it is asserting over', () => {
    // Guards the assertion below against an empty listing passing vacuously.
    expect(sources.length).toBeGreaterThan(4)
    expect(sources.map((entry) => entry.replaceAll('\\', '/'))).toContain('inputs.ts')
  })

  it.each(['getInput', 'getBooleanInput'])(
    'calls %s in src/inputs.ts and nowhere else',
    (call) => {
      const callers = sources.filter(
        (entry) => readFileSync(`${srcRoot}${entry}`, 'utf8').includes(call),
      )
      expect(callers.map((entry) => entry.replaceAll('\\', '/'))).toEqual(['inputs.ts'])
    },
  )

  it('reads the environment only through the toolkit', () => {
    const source = readFileSync(`${srcRoot}inputs.ts`, 'utf8')
    expect(source).not.toContain('process.env')
  })
})
