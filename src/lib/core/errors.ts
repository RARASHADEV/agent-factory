// src/lib/core/errors.ts
// AF-58: Typed errors for presentation-free core ops.
//
// Core ops never call process.exit or write to the console. When a project
// cannot be resolved, they throw ProjectNotFoundError. The CLI catches it and
// prints the existing message + exits(1); the HTTP service maps it to a 404.

/** No project could be resolved from the given prefix or the current directory. */
export class ProjectNotFoundError extends Error {
  constructor(public readonly prefix?: string) {
    super('No project found. Run `af init <prefix>` or use --project <prefix>.');
    this.name = 'ProjectNotFoundError';
  }
}
