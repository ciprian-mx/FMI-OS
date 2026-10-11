/**
 * Structural types for injecting AWS SDK for JavaScript v3 clients into the
 * backend cores (see amplify/README.md, "Backend function convention").
 *
 * Adapters are written against the *shape* of the SDK
 * (`client.send(new XCommand(input))`) instead of importing it: each Lambda's
 * `src/index.js` passes the real client and command classes, and tests pass
 * recording fakes. Nothing under `src/backend/` imports `@aws-sdk/*`.
 */

/** Any AWS SDK v3 client. */
export interface SdkClientLike {
  send(command: unknown): Promise<unknown>;
}

/** An AWS SDK v3 command class, e.g. `RetrieveCommand`. */
export type CommandClass<TInput> = new (input: TInput) => unknown;
