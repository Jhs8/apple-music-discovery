export class MusicKitAuthError extends Error {
  readonly kind: "denied" | "error";
  readonly code: string;

  constructor(
    kind: "denied" | "error",
    code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options && "cause" in options ? { cause: options.cause } : undefined);
    this.name = "MusicKitAuthError";
    this.kind = kind;
    this.code = code;
  }
}

const SDK_CODE = /^[A-Z0-9_]+$/;

export function readSdkError(value: unknown): { code: string; message: string } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as { errorCode?: unknown; reason?: unknown; description?: unknown; message?: unknown };
  const code =
    typeof record.errorCode === "string" && SDK_CODE.test(record.errorCode)
      ? record.errorCode
      : typeof record.reason === "string" && SDK_CODE.test(record.reason)
        ? record.reason
        : undefined;
  if (!code) {
    return undefined;
  }
  const message =
    typeof record.description === "string"
      ? record.description
      : typeof record.message === "string"
        ? record.message
        : code;
  return { code, message };
}

export function scrubMessage(message: string, code: string, secrets: readonly string[]): string {
  for (const secret of secrets) {
    if (secret.length > 0 && message.includes(secret)) {
      return code;
    }
  }
  return message;
}
