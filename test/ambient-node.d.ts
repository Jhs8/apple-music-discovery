declare module "node:test" {
  export function test(name: string, fn: () => unknown): Promise<void> | void;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(block: () => unknown, error?: (thrown: unknown) => boolean, message?: string): void;
    rejects(
      block: (() => Promise<unknown>) | Promise<unknown>,
      error?: (thrown: unknown) => boolean,
      message?: string,
    ): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}
