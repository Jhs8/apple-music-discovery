import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MusicKitAuthClient,
  MusicKitAuthError,
  type MusicKitAuthSession,
} from "../src/musickit/auth-client.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeSession implements MusicKitAuthSession {
  configureCount = 0;
  authorizeCount = 0;
  unauthorizeCount = 0;
  authorized = false;
  configureResult: () => Promise<unknown> = async () => undefined;
  authorizeResult: () => Promise<string | undefined> = async () => "test-music-user-token";
  unauthorizeResult: () => Promise<unknown> = async () => undefined;
  seenConfigure: unknown;

  async configure(input: {
    developerToken: string;
    app: { name: string; build?: string };
  }): Promise<unknown> {
    this.configureCount += 1;
    this.seenConfigure = input;
    return this.configureResult();
  }

  authorize(): Promise<string | undefined> {
    this.authorizeCount += 1;
    return this.authorizeResult();
  }

  unauthorize(): Promise<unknown> {
    this.unauthorizeCount += 1;
    return this.unauthorizeResult();
  }

  isAuthorized(): boolean {
    return this.authorized;
  }
}

function clientFor(session: FakeSession, providerToken: () => string | Promise<string> = () => "test-developer-token") {
  return new MusicKitAuthClient({
    appName: "apple-music-discovery",
    tokenProvider: { getDeveloperToken: providerToken },
    session,
  });
}

async function authError(
  run: () => Promise<unknown>,
): Promise<MusicKitAuthError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof MusicKitAuthError);
    return error;
  }
  assert.fail("expected MusicKitAuthError");
}

test("constructor rejects a blank app name or app build", () => {
  const session = new FakeSession();
  assert.throws(
    () =>
      new MusicKitAuthClient({
        appName: "  ",
        tokenProvider: { getDeveloperToken: () => "test-developer-token" },
        session,
      }),
    (error: unknown) => {
      assert.ok(error instanceof MusicKitAuthError);
      assert.equal(error.kind, "error");
      assert.equal(error.code, "MISSING_APP_NAME");
      assert.equal(error.message, "App name is empty.");
      return true;
    },
  );
  assert.throws(
    () =>
      new MusicKitAuthClient({
        appName: "apple-music-discovery",
        appBuild: " ",
        tokenProvider: { getDeveloperToken: () => "test-developer-token" },
        session,
      }),
    (error: unknown) => {
      assert.ok(error instanceof MusicKitAuthError);
      assert.equal(error.code, "MISSING_APP_BUILD");
      assert.equal(error.message, "App build is empty.");
      return true;
    },
  );
  assert.equal(session.configureCount, 0);
});

test("authorize success discards the music user token", async () => {
  const session = new FakeSession();
  const client = clientFor(session);
  const result = await client.authorize();
  assert.deepEqual(result, { status: "authorized" });
  assert.equal(client.getStatus(), "authorized");
  assert.equal(session.authorizeCount, 1);
  assert.equal(session.unauthorizeCount, 0);
  assert.equal(session.authorized, false);
  assert.equal(JSON.stringify(result), '{"status":"authorized"}');
  assert.equal(JSON.stringify(client), "{}");
  assert.equal(JSON.stringify(result).includes("test-music-user-token"), false);
  assert.equal(JSON.stringify(client).includes("test-developer-token"), false);
  assert.equal(JSON.stringify(client).includes("test-music-user-token"), false);
  await client.authorize();
  assert.equal(session.authorizeCount, 2);
  assert.equal(session.configureCount, 1);
});

test("configure sends the trimmed app name and build only when provided", async () => {
  const session = new FakeSession();
  const client = new MusicKitAuthClient({
    appName: "  apple-music-discovery  ",
    appBuild: " test ",
    tokenProvider: { getDeveloperToken: () => "  test-developer-token  " },
    session,
  });
  await client.configure();
  assert.deepEqual(session.seenConfigure, {
    developerToken: "test-developer-token",
    app: { name: "apple-music-discovery", build: "test" },
  });
  assert.equal(client.getStatus(), "configured");
  assert.equal(client.getPending(), null);
});

test("overlapping configure calls share one provider request", async () => {
  const session = new FakeSession();
  const gate = deferred<void>();
  session.configureResult = () => gate.promise;
  let calls = 0;
  const client = clientFor(session, () => {
    calls += 1;
    return "test-developer-token";
  });
  const first = client.configure();
  const second = client.configure();
  assert.equal(client.getPending(), "configure");
  gate.resolve();
  await first;
  await second;
  assert.equal(calls, 1);
  assert.equal(session.configureCount, 1);
  assert.equal(client.getPending(), null);
});

test("authorization error is denial and does not call unauthorize again", async () => {
  const session = new FakeSession();
  session.authorizeResult = async () => {
    throw {
      name: "MKError",
      reason: "AUTHORIZATION_ERROR",
      errorCode: "AUTHORIZATION_ERROR",
      message: "Unauthorized",
    };
  };
  const client = clientFor(session);
  const error = await authError(() => client.authorize());
  assert.equal(error.kind, "denied");
  assert.equal(error.code, "AUTHORIZATION_ERROR");
  assert.equal(error.message, "MusicKit authorization was not granted.");
  assert.equal(error.message.includes("test-developer-token"), false);
  assert.equal(client.getStatus(), "unauthorized");
  assert.equal(session.unauthorizeCount, 0);
});

test("an empty authorize result is denial after one unauthorize", async () => {
  const session = new FakeSession();
  session.authorized = true;
  session.authorizeResult = async () => undefined;
  const client = clientFor(session);
  const error = await authError(() => client.authorize());
  assert.equal(error.kind, "denied");
  assert.equal(error.code, "AUTHORIZATION_ERROR");
  assert.equal(error.message, "MusicKit authorization was not granted.");
  assert.equal(session.unauthorizeCount, 1);
  assert.equal(client.getStatus(), "unauthorized");
});

test("network and unauthorized sdk errors stay errors and can scrub the developer token", async () => {
  const session = new FakeSession();
  session.authorizeResult = async () => {
    throw { reason: "NETWORK_ERROR", errorCode: "NETWORK_ERROR", message: "offline" };
  };
  const client = clientFor(session);
  const network = await authError(() => client.authorize());
  assert.equal(network.kind, "error");
  assert.equal(network.code, "NETWORK_ERROR");
  assert.equal(network.message, "offline");
  assert.equal(client.getStatus(), "configured");

  session.authorizeResult = async () => {
    throw {
      reason: "NETWORK_ERROR",
      errorCode: "SERVER_ERROR",
      description: "bad test-developer-token",
    };
  };
  const scrubbed = await authError(() => client.authorize());
  assert.equal(scrubbed.code, "SERVER_ERROR");
  assert.equal(scrubbed.message, "SERVER_ERROR");
  assert.equal(scrubbed.message.includes("test-developer-token"), false);

  session.authorizeResult = async () => {
    throw { errorCode: "UNAUTHORIZED_ERROR", message: "nope" };
  };
  const unauthorized = await authError(() => client.authorize());
  assert.equal(unauthorized.kind, "error");
  assert.equal(unauthorized.code, "UNAUTHORIZED_ERROR");
});

test("a missing or throwing developer token does not configure the session", async () => {
  const blank = new FakeSession();
  const blankClient = clientFor(blank, () => "   ");
  const missing = await authError(() => blankClient.configure());
  assert.equal(missing.code, "MISSING_DEVELOPER_TOKEN");
  assert.equal(missing.message, "Developer token is empty.");
  assert.equal(blank.configureCount, 0);
  assert.equal(blankClient.getStatus(), "unconfigured");

  const cause = new Error("backend down");
  const failing = new FakeSession();
  const failingClient = clientFor(failing, () => {
    throw cause;
  });
  const provider = await authError(() => failingClient.authorize());
  assert.equal(provider.kind, "error");
  assert.equal(provider.code, "DEVELOPER_TOKEN_PROVIDER_FAILED");
  assert.equal(provider.message, "Developer token provider failed.");
  assert.equal(provider.cause, cause);
  assert.equal(failing.configureCount, 0);
});

test("unauthorize before configure does not revoke a session restored later", async () => {
  const session = new FakeSession();
  const client = clientFor(session);
  assert.deepEqual(await client.unauthorize(), { status: "unauthorized" });
  assert.equal(session.unauthorizeCount, 0);
  session.authorized = true;
  await client.configure();
  assert.equal(session.unauthorizeCount, 0);
  assert.equal(client.getStatus(), "authorized");
});

test("overlapping authorize calls share one sdk authorize", async () => {
  const session = new FakeSession();
  const gate = deferred<string | undefined>();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  session.authorizeResult = () => {
    entered();
    return gate.promise;
  };
  const client = clientFor(session);
  const first = client.authorize();
  await started;
  assert.equal(client.getPending(), "authorize");
  const second = client.authorize();
  gate.resolve("test-music-user-token");
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, { status: "authorized" });
  assert.equal(a, b);
  assert.equal(session.authorizeCount, 1);
});

test("unauthorize during authorize supersedes the sign-in", async () => {
  const session = new FakeSession();
  const gate = deferred<string | undefined>();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  session.authorizeResult = () => {
    entered();
    return gate.promise;
  };
  const client = clientFor(session);
  const signingIn = client.authorize();
  await started;
  const signingOut = client.unauthorize();
  assert.equal(client.getPending(), "authorize");
  gate.resolve("test-music-user-token");
  const error = await authError(() => signingIn);
  assert.equal(error.kind, "denied");
  assert.equal(error.code, "AUTHORIZATION_ERROR");
  assert.equal(error.message, "Authorization superseded by unauthorize.");
  assert.equal(error.message.includes("test-music-user-token"), false);
  assert.deepEqual(await signingOut, { status: "unauthorized" });
  assert.equal(session.unauthorizeCount, 1);
  assert.equal(session.authorizeCount, 1);
  assert.equal(client.getStatus(), "unauthorized");
  assert.equal(client.getPending(), null);
});

test("a second unauthorize shares the in-flight sign-out", async () => {
  const session = new FakeSession();
  const gate = deferred<void>();
  session.unauthorizeResult = () => gate.promise.then(() => undefined);
  const client = clientFor(session);
  await client.configure();
  const first = client.unauthorize();
  const second = client.unauthorize();
  assert.equal(client.getPending(), "unauthorize");
  gate.resolve();
  await first;
  await second;
  assert.equal(session.unauthorizeCount, 1);
  assert.equal(client.getStatus(), "unauthorized");
});

test("configure restored authorization is reported without calling authorize", async () => {
  const session = new FakeSession();
  session.authorized = true;
  const client = clientFor(session);
  await client.configure();
  assert.equal(client.getStatus(), "authorized");
  assert.equal(session.authorizeCount, 0);
});
