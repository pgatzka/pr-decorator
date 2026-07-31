/**
 * Shared type surface. Every other module in the action depends on these shapes,
 * so treat them as frozen: a change here ripples into every open branch.
 */

/** Where the managed block is placed the first time it is written. */
export type Position = 'top' | 'bottom'

/** How a commit author is rendered on the commit line. */
export type MentionStyle = 'login' | 'name'

/** The eight `action.yml` inputs, already parsed and validated. */
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
  /** Already-resolved author rendering — `@login`, or the plain git name. */
  mention: string
  /** First line of the commit message, already neutralized for GFM. */
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
