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
