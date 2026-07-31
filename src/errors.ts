/**
 * How the entrypoint should report a failure. The mapping onto `core.setFailed`,
 * `core.warning` and `core.notice` lives in the entrypoint alone — nothing else
 * in the action decides whether the run fails.
 */
export type Severity = 'fatal' | 'warning' | 'notice'

/** An error carrying the severity the entrypoint should report it at. */
export class DecoratorError extends Error {
  readonly severity: Severity

  constructor(message: string, severity: Severity = 'fatal', options?: ErrorOptions) {
    super(message, options)
    this.name = 'DecoratorError'
    this.severity = severity
  }
}

/**
 * Which client call failed. Machine-readable on purpose: the caller has to tell a
 * failed read from a failed write without parsing a message.
 */
export type GitHubOperation = 'getPullRequest' | 'listCommits' | 'getBody' | 'updateBody'

/**
 * A GitHub API call that came back with an HTTP status the action cannot work
 * with. Fatal: a 404, 422 or 5xx means the run cannot produce a correct block.
 */
export class GitHubApiError extends DecoratorError {
  /** The client call that failed. */
  readonly operation: GitHubOperation
  /** The HTTP status GitHub replied with. */
  readonly status: number

  constructor(
    operation: GitHubOperation,
    status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, 'fatal', options)
    this.name = 'GitHubApiError'
    this.operation = operation
    this.status = status
  }
}

/**
 * GitHub replied 403 to a read or a write. Raised at `warning` severity because
 * the common cause is the read-only `GITHUB_TOKEN` a fork pull request gets, which
 * is not the consumer's mistake and must not fail their run — but this class only
 * classifies. Whether a given 403 is survivable is decided by the caller.
 */
export class PermissionDeniedError extends DecoratorError {
  /** The client call that was denied. */
  readonly operation: GitHubOperation
  /** Always 403; present so callers can handle it alongside {@link GitHubApiError}. */
  readonly status: number

  constructor(operation: GitHubOperation, message: string, options?: ErrorOptions) {
    super(message, 'warning', options)
    this.name = 'PermissionDeniedError'
    this.operation = operation
    this.status = 403
  }
}
