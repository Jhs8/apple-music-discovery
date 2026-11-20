import assert from "node:assert/strict";
import { test } from "node:test";
import { MusicKitAuthError } from "../src/musickit/errors.ts";
import {
  MUSICKIT_LOADED_EVENT,
  MUSICKIT_SCRIPT_SRC,
  SCRIPT_LOAD_TIMEOUT_MS,
  createBrowserMusicKitSession,
} from "../src/musickit/browser-loader.ts";

type Listener = () => void;

class FakeScript {
  async = false;
  src = "";
  #listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.#listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener();
    }
  }
}

class FakeParent {
  children: FakeScript[] = [];

  appendChild(node: FakeScript): void {
    this.children.push(node);
  }
}

class FakeDocument {
  head: FakeParent | null = new FakeParent();
  documentElement = new FakeParent();
  #listeners = new Map<string, Set<Listener>>();

  createElement(tagName: string): FakeScript {
    if (tagName !== "script") {
      throw new Error(`unexpected element ${tagName}`);
    }
    return new FakeScript();
  }

  querySelector(selectors: string): FakeScript | null {
    const match = /^script\[src="([^"]+)"\]$/.exec(selectors);
    if (!match) {
      return null;
    }
    const src = match[1];
    for (const parent of [this.head, this.documentElement]) {
      if (!parent) {
        continue;
      }
      for (const child of parent.children) {
        if (child.src === src) {
          return child;
        }
      }
    }
    return null;
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.#listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener();
    }
  }
}

interface FakeInstance {
  authorize: () => Promise<string | undefined>;
  unauthorize: () => Promise<unknown>;
  readonly isAuthorized: boolean;
  readonly musicUserToken: string;
}

interface FakeMusicKit {
  configure: (config: unknown) => Promise<unknown>;
  getInstance?: () => unknown;
}

function instance(): FakeInstance {
  return {
    authorize: async () => "test-music-user-token",
    unauthorize: async () => undefined,
    get isAuthorized() {
      return false;
    },
    get musicUserToken(): string {
      throw new Error("musicUserToken was read");
    },
  };
}

function harness(options?: { head?: boolean }): {
  document: FakeDocument;
  window: { MusicKit?: FakeMusicKit };
} {
  const document = new FakeDocument();
  if (options?.head === false) {
    document.head = null;
  }
  return { document, window: {} };
}

function sessionFor(parts: { document: FakeDocument; window: { MusicKit?: FakeMusicKit } }, timeoutMs?: number) {
  return createBrowserMusicKitSession({
    document: parts.document as unknown as Document,
    window: parts.window as unknown as Window,
    timeoutMs,
  });
}

async function authError(run: () => Promise<unknown>): Promise<MusicKitAuthError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof MusicKitAuthError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected MusicKitAuthError");
}

test("the loader constants name the v3 script", () => {
  assert.equal(MUSICKIT_SCRIPT_SRC, "https://js-cdn.music.apple.com/musickit/v3/musickit.js");
  assert.equal(MUSICKIT_LOADED_EVENT, "musickitloaded");
  assert.equal(SCRIPT_LOAD_TIMEOUT_MS, 10000);
});

test("configure appends one async script and passes the developer token", async () => {
  const parts = harness();
  let seen: unknown;
  const music = instance();
  const session = sessionFor(parts);
  const pending = session.configure({
    developerToken: "test-developer-token",
    app: { name: "apple-music-discovery", build: "test" },
  });
  await Promise.resolve();
  assert.equal(parts.document.head?.children.length, 1);
  const script = parts.document.head?.children[0];
  assert.equal(script?.src, MUSICKIT_SCRIPT_SRC);
  assert.equal(script?.async, true);
  parts.window.MusicKit = {
    configure: async (config) => {
      seen = config;
      return music;
    },
  };
  parts.document.dispatch(MUSICKIT_LOADED_EVENT);
  await pending;
  assert.deepEqual(seen, {
    developerToken: "test-developer-token",
    app: { name: "apple-music-discovery", build: "test" },
  });
  assert.equal("persist" in (seen as object), false);
  assert.equal(await session.authorize(), "test-music-user-token");
  assert.equal(session.isAuthorized(), false);
});

test("configure omits build when the caller omits it", async () => {
  const parts = harness();
  let seen: { app: Record<string, unknown> } | undefined;
  parts.window.MusicKit = {
    configure: async (config) => {
      seen = config as { app: Record<string, unknown> };
      return instance();
    },
  };
  await sessionFor(parts).configure({
    developerToken: "test-developer-token",
    app: { name: "apple-music-discovery" },
  });
  assert.deepEqual(seen?.app, { name: "apple-music-discovery" });
  assert.equal(seen !== undefined && "build" in seen.app, false);
  assert.equal(parts.document.head?.children.length, 0);
});

test("an existing script tag is reused", async () => {
  const parts = harness();
  const existing = parts.document.createElement("script");
  existing.src = MUSICKIT_SCRIPT_SRC;
  parts.document.head?.appendChild(existing);
  const session = sessionFor(parts);
  const pending = session.configure({
    developerToken: "test-developer-token",
    app: { name: "apple-music-discovery" },
  });
  await Promise.resolve();
  assert.equal(parts.document.head?.children.length, 1);
  parts.window.MusicKit = { configure: async () => instance() };
  parts.document.dispatch(MUSICKIT_LOADED_EVENT);
  await pending;
});

test("a missing head appends the script to documentElement", async () => {
  const parts = harness({ head: false });
  const session = sessionFor(parts);
  const pending = session.configure({
    developerToken: "test-developer-token",
    app: { name: "apple-music-discovery" },
  });
  await Promise.resolve();
  assert.equal(parts.document.documentElement.children.length, 1);
  parts.window.MusicKit = { configure: async () => instance() };
  parts.document.dispatch(MUSICKIT_LOADED_EVENT);
  await pending;
});

test("a second configure with a different token does not call MusicKit again", async () => {
  const parts = harness();
  let calls = 0;
  parts.window.MusicKit = {
    configure: async () => {
      calls += 1;
      return instance();
    },
  };
  const session = sessionFor(parts);
  await session.configure({
    developerToken: "test-developer-token",
    app: { name: "apple-music-discovery", build: "test" },
  });
  const error = await authError(() =>
    session.configure({
      developerToken: "other-token",
      app: { name: "apple-music-discovery", build: "test" },
    }),
  );
  assert.equal(error.code, "TOKEN_ALREADY_CONFIGURED");
  assert.equal(error.message, "MusicKit session is already configured.");
  assert.equal(calls, 1);
});

test("configure falls back to getInstance when configure returns a non-instance", async () => {
  const parts = harness();
  const music = instance();
  parts.window.MusicKit = {
    configure: async () => 1,
    getInstance: () => music,
  };
  const session = sessionFor(parts);
  await session.configure({
    developerToken: "test-developer-token",
    app: { name: "apple-music-discovery" },
  });
  assert.equal(session.isAuthorized(), false);
});

test("a window that never defines MusicKit times out", async () => {
  const parts = harness();
  const error = await authError(() =>
    sessionFor(parts, 20).configure({
      developerToken: "test-developer-token",
      app: { name: "apple-music-discovery" },
    }),
  );
  assert.equal(error.code, "SCRIPT_LOAD_TIMEOUT");
  assert.equal(error.message, "MusicKit JS did not load within 20 milliseconds.");
});

test("a script error rejects SCRIPT_LOAD_FAILED", async () => {
  const parts = harness();
  const session = sessionFor(parts);
  const pending = session.configure({
    developerToken: "test-developer-token",
    app: { name: "apple-music-discovery" },
  });
  await Promise.resolve();
  parts.document.head?.children[0]?.dispatch("error");
  const error = await authError(() => pending);
  assert.equal(error.code, "SCRIPT_LOAD_FAILED");
  assert.equal(error.message, "MusicKit JS script failed to load.");
});

test("configure without a document rejects NOT_IN_BROWSER", async () => {
  const error = await authError(() =>
    createBrowserMusicKitSession().configure({
      developerToken: "test-developer-token",
      app: { name: "apple-music-discovery" },
    }),
  );
  assert.equal(error.code, "NOT_IN_BROWSER");
  assert.equal(error.message, "MusicKit JS requires a browser document.");
});

test("authorize before configure rejects NOT_CONFIGURED", async () => {
  const parts = harness();
  const error = await authError(() => sessionFor(parts).authorize());
  assert.equal(error.code, "NOT_CONFIGURED");
  assert.equal(error.message, "MusicKit session is not configured.");
});

test("musickitloaded without a configure function rejects NOT_CONFIGURED", async () => {
  const parts = harness();
  const session = sessionFor(parts);
  const pending = session.configure({
    developerToken: "test-developer-token",
    app: { name: "apple-music-discovery" },
  });
  await Promise.resolve();
  parts.window.MusicKit = {} as FakeMusicKit;
  parts.document.dispatch(MUSICKIT_LOADED_EVENT);
  const error = await authError(() => pending);
  assert.equal(error.code, "NOT_CONFIGURED");
});

test("importing the package entry does not require a browser", async () => {
  await import("../src/index.ts");
});
