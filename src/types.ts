/**
 * Shared type surface. Every other module in the action depends on these shapes,
 * so treat them as frozen: a change here ripples into every open branch.
 */

/** Where the managed block is placed the first time it is written. */
export type Position = 'top' | 'bottom'

/** How a commit author is rendered on the commit line. */
export type MentionStyle = 'login' | 'name'

/** The nine `action.yml` inputs, already parsed and validated. */
export interface DecoratorInputs {
  /** IANA timezone name used to format commit author timestamps. */
  timezone: string
  /** Token used for the GitHub API calls. */
  token: string
  /** Placement of the managed block on first write. */
  position: Position
  /** Whether the `Closes #N` line is emitted. */
  issueLink: boolean
  /** Matched against the head branch name; capture group 1 is the issue number. */
  branchPattern: RegExp
  /** Whether the footer line is emitted. */
  footer: boolean
  /** Whether authors render as `@login` or as the plain git name. */
  mentions: MentionStyle
  /**
   * Whether the pull request title is fully managed and set to
   * `#<issueId> <issue title, lowercased>` when an issue number resolves from
   * the head branch name. Independent of {@link DecoratorInputs.issueLink} —
   * both read the number from the same branch match, but turning one off does
   * not turn the other off.
   */
  title: boolean
  /** Render and log only; never write to the pull request. */
  dryRun: boolean
}

/**
 * A single commit, reduced to exactly what the render layer needs. The render
 * layer never sees the raw API payload.
 */
export interface RenderableCommit {
  /** Abbreviated SHA as displayed, e.g. `a1b2c3d`. */
  shortSha: string
  /** Full 40-character SHA, used to build the commit URL. */
  fullSha: string
  /**
   * The commit AUTHOR date as an instant. Never a preformatted string: the
   * timezone is applied once, in the formatter, so callers cannot smuggle in a
   * differently formatted timestamp.
   */
  authoredAt: Date
  /**
   * Already-resolved AND already-escaped author rendering — `@login`, or the plain
   * git name. The bullet renderer emits it verbatim.
   */
  mention: string
  /**
   * The commit message, exactly as the API served it. Deliberately NOT pre-escaped
   * and deliberately not pre-trimmed to one line: the bullet renderer takes the
   * first line and neutralizes it, so there is exactly one place where an
   * attacker-controlled subject is made safe.
   */
  subject: string
}

/** The assembled managed block, markers included. */
export interface RenderedBlock {
  /** The complete block text, from the start marker through the end marker. */
  text: string
  /** How many commits are rendered in {@link RenderedBlock.text}. */
  renderedCommits: number
  /** How many commits the character budget dropped from the list. */
  omittedCommits: number
}
