import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/**
 * `action.yml` is the public contract of `uses: pgatzka/pr-decorator@v1`.
 * Changing an input name, its default or its required flag breaks every consumer
 * and needs a major tag, so the whole surface is pinned here.
 */

interface ActionInput {
  description?: string
  required?: boolean
  default?: string
}

interface ActionYml {
  name?: string
  description?: string
  branding?: { icon?: string; color?: string }
  inputs?: Record<string, ActionInput>
  outputs?: Record<string, unknown>
  runs?: { using?: string; main?: string }
}

const actionYmlPath = fileURLToPath(new URL('../action.yml', import.meta.url))
const raw = readFileSync(actionYmlPath, 'utf8')
const action = parse(raw) as ActionYml

const EXPECTED_INPUTS = [
  'timezone',
  'token',
  'position',
  'issue-link',
  'branch-pattern',
  'footer',
  'mentions',
  'title',
  'dry-run',
] as const

const EXPECTED_DEFAULTS: Record<string, string | undefined> = {
  timezone: undefined,
  token: '${{ github.token }}',
  position: 'top',
  'issue-link': 'true',
  'branch-pattern': String.raw`^(\d+)-`,
  footer: 'true',
  mentions: 'login',
  title: 'true',
  'dry-run': 'false',
}

describe('action.yml', () => {
  it('declares exactly the nine v1 inputs', () => {
    expect(Object.keys(action.inputs ?? {})).toEqual([...EXPECTED_INPUTS])
  })

  it('requires timezone and nothing else', () => {
    const required = Object.entries(action.inputs ?? {})
      .filter(([, input]) => input.required === true)
      .map(([name]) => name)
    expect(required).toEqual(['timezone'])
  })

  it('gives timezone no default, so an omitted timezone fails fast', () => {
    expect(action.inputs?.timezone).toBeDefined()
    expect(action.inputs?.timezone).not.toHaveProperty('default')
  })

  it.each(EXPECTED_INPUTS.filter((name) => name !== 'timezone'))(
    'defaults %s to its documented value',
    (name) => {
      expect(action.inputs?.[name]?.default).toBe(EXPECTED_DEFAULTS[name])
    },
  )

  it('describes every input', () => {
    for (const name of EXPECTED_INPUTS) {
      expect(action.inputs?.[name]?.description, name).toBeTruthy()
    }
  })

  it('runs the committed bundle', () => {
    expect(action.runs?.main).toBe('dist/index.js')
    expect(action.runs?.using).toBe('node24')
  })

  it('declares no outputs in v1', () => {
    expect(action).not.toHaveProperty('outputs')
  })

  it('carries name, description and branding for the marketplace listing', () => {
    expect(action.name).toBeTruthy()
    expect(action.description).toBeTruthy()
    expect(action.branding?.icon).toBeTruthy()
    expect(action.branding?.color).toBeTruthy()
  })
})
