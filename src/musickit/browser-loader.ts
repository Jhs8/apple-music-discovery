import type { MusicKitAuthSession } from "./auth-client.ts";
import { MusicKitAuthError } from "./errors.ts";

export const MUSICKIT_SCRIPT_SRC = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
export const MUSICKIT_LOADED_EVENT = "musickitloaded";
export const SCRIPT_LOAD_TIMEOUT_MS = 10_000;

interface MusicKitInstanceLike {
  authorize: () => Promise<string | undefined>;
  unauthorize: () => Promise<unknown>;
  readonly isAuthorized: boolean;
}

interface MusicKitNamespace {
  configure: (config: {
    developerToken: string;
    app: { name: string; build?: string };
  }) => Promise<unknown>;
  getInstance?: () => unknown;
}

interface ScriptLike {
  async: boolean;
  src: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface ParentLike {
  appendChild(node: ScriptLike): void;
}

interface DocumentLike {
  head: ParentLike | null;
  documentElement: ParentLike;
  createElement(tagName: "script"): ScriptLike;
  querySelector(selectors: string): ScriptLike | null;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface WindowLike {
  MusicKit?: MusicKitNamespace;
}

interface ConfigureInput {
  developerToken: string;
  app: { name: string; build?: string };
}

export function createBrowserMusicKitSession(options?: {
  document?: Document;
  window?: Window;
  timeoutMs?: number;
}): MusicKitAuthSession {
  const timeoutMs = options?.timeoutMs ?? SCRIPT_LOAD_TIMEOUT_MS;
  let configured: ConfigureInput | undefined;
  let current: MusicKitInstanceLike | undefined;

  return {
    async configure(input) {
      if (configured) {
        if (!sameIdentity(configured, input)) {
          throw new MusicKitAuthError(
            "error",
            "TOKEN_ALREADY_CONFIGURED",
            "MusicKit session is already configured.",
          );
        }
        return;
      }
      const doc = resolveDocument(options?.document);
      const win = resolveWindow(options?.window);
      if (!isReady(win)) {
        const script = ensureScript(doc);
        await waitForMusicKit(doc, win, script, timeoutMs);
      }
      const namespace = win.MusicKit;
      if (!namespace || typeof namespace.configure !== "function") {
        throw new MusicKitAuthError("error", "NOT_CONFIGURED", "MusicKit session is not configured.");
      }
      const result = await namespace.configure(sdkConfig(input));
      const instance = resolveInstance(result, namespace);
      if (!instance) {
        throw new MusicKitAuthError("error", "NOT_CONFIGURED", "MusicKit session is not configured.");
      }
      current = instance;
      configured = {
        developerToken: input.developerToken,
        app: { name: input.app.name, build: input.app.build },
      };
    },
    authorize() {
      return requireInstance(current).authorize();
    },
    unauthorize() {
      return requireInstance(current).unauthorize();
    },
    isAuthorized() {
      return requireInstance(current).isAuthorized;
    },
  };
}

function requireInstance(current: MusicKitInstanceLike | undefined): MusicKitInstanceLike {
  if (!current) {
    throw new MusicKitAuthError("error", "NOT_CONFIGURED", "MusicKit session is not configured.");
  }
  return current;
}

function sameIdentity(left: ConfigureInput, right: ConfigureInput): boolean {
  return (
    left.developerToken === right.developerToken &&
    left.app.name === right.app.name &&
    left.app.build === right.app.build
  );
}

function sdkConfig(input: ConfigureInput): ConfigureInput {
  const app: { name: string; build?: string } = { name: input.app.name };
  if (input.app.build !== undefined) {
    app.build = input.app.build;
  }
  return { developerToken: input.developerToken, app };
}

function resolveDocument(explicit: Document | undefined): DocumentLike {
  const document = explicit ?? globalDocument();
  if (!document) {
    throw new MusicKitAuthError("error", "NOT_IN_BROWSER", "MusicKit JS requires a browser document.");
  }
  return document as unknown as DocumentLike;
}

function globalDocument(): Document | undefined {
  if (!("document" in globalThis)) {
    return undefined;
  }
  return (globalThis as { document?: Document }).document;
}

function resolveWindow(explicit: Window | undefined): WindowLike {
  const window = explicit ?? globalWindow();
  return window as unknown as WindowLike;
}

function globalWindow(): Window {
  if ("window" in globalThis && (globalThis as { window?: Window }).window) {
    return (globalThis as { window: Window }).window;
  }
  return globalThis as unknown as Window;
}

function isReady(win: WindowLike): boolean {
  return typeof win.MusicKit?.configure === "function";
}

function ensureScript(doc: DocumentLike): ScriptLike {
  const selector = `script[src="${MUSICKIT_SCRIPT_SRC}"]`;
  const existing = doc.querySelector(selector);
  if (existing) {
    return existing;
  }
  const script = doc.createElement("script");
  script.async = true;
  script.src = MUSICKIT_SCRIPT_SRC;
  const parent = doc.head ?? doc.documentElement;
  parent.appendChild(script);
  return script;
}

function waitForMusicKit(
  doc: DocumentLike,
  win: WindowLike,
  script: ScriptLike,
  timeoutMs: number,
): Promise<void> {
  if (isReady(win)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      doc.removeEventListener(MUSICKIT_LOADED_EVENT, onLoaded);
      script.removeEventListener("error", onError);
      action();
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(
          new MusicKitAuthError(
            "error",
            "SCRIPT_LOAD_TIMEOUT",
            `MusicKit JS did not load within ${timeoutMs} milliseconds.`,
          ),
        );
      });
    }, timeoutMs);
    const onLoaded = () => {
      finish(() => {
        if (isReady(win)) {
          resolve();
          return;
        }
        reject(new MusicKitAuthError("error", "NOT_CONFIGURED", "MusicKit session is not configured."));
      });
    };
    const onError = () => {
      finish(() => {
        reject(new MusicKitAuthError("error", "SCRIPT_LOAD_FAILED", "MusicKit JS script failed to load."));
      });
    };
    doc.addEventListener(MUSICKIT_LOADED_EVENT, onLoaded);
    script.addEventListener("error", onError);
  });
}

function resolveInstance(result: unknown, namespace: MusicKitNamespace): MusicKitInstanceLike | undefined {
  if (isInstance(result)) {
    return result;
  }
  if (typeof namespace.getInstance !== "function") {
    return undefined;
  }
  const fallback = namespace.getInstance();
  return isInstance(fallback) ? fallback : undefined;
}

function isInstance(value: unknown): value is MusicKitInstanceLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<MusicKitInstanceLike>;
  return (
    typeof record.authorize === "function" &&
    typeof record.unauthorize === "function" &&
    typeof record.isAuthorized === "boolean"
  );
}
