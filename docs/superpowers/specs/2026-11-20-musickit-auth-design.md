# MusicKit authorization wrapper

Status: design checkpoint for review. Written 2026-11-19. No application code is in this commit.

This milestone adds a small TypeScript library to the currently README-only repository: domain records for a song, a recommendation, and explicit feedback, plus a MusicKit on the Web authorization client. The client configures MusicKit with a developer token supplied from outside the repo, asks the SDK to authorize or unauthorize, and exposes a small auth state. Tests drive a mock session. They do not sign in to Apple.

## Decision

Build the minimal SDK wrapper. A full demo page (sign-in button, catalog search, playback, library, or playlist editing) needs a hosted origin, a real developer token, and a person at the Apple authorization popup. That demo cannot be verified by the mock tests in this milestone, and it pulls in playback and library writes. The wrapper is the piece those tests can pin down.

## Sources checked

Behavior below was read from the shipped script, not from memory or from `@types/musickit-js`.

| Source | What it established |
| --- | --- |
| `https://js-cdn.music.apple.com/musickit/v3/musickit.js` fetched 2026-11-19. Response headers: `x-apple-version-number: 3.2526.0`, `last-modified: Thu, 26 Jun 2025 19:10:37 GMT`. | `configure`, `authorize`, `unauthorize`, `isAuthorized`, `MKError`, popup reject codes, and default token storage. |
| [Generating Developer Tokens](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens) | ES256 developer JWT, `kid`, `iss` (Team ID), `iat`, `exp` at most 15777000 seconds, optional `origin` claim. Non-ES256 tokens are rejected with HTTP 401. |
| [User Authentication for MusicKit](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit) | For web, MusicKit on the Web attaches the Music User Token to Apple Music API requests. Android is the platform that puts the token on a manual `Music-User-Token` header. |

Apple's hosted MusicKit on the Web story text says `authorize()` resolves `undefined` when authorization fails or the user cancels. In script 3.2526.0 the public `authorize()` method does not do that for the popup failure paths. Those paths reject, and the method throws `MKError` with reason `AUTHORIZATION_ERROR` and message `Unauthorized`. This spec follows the script. A later CDN publish of the same URL can change that; the mock tests lock the wrapper's mapping, and they do not claim the live script still matches 3.2526.0.

`@types/musickit-js` is not a dependency. Its `authorize(): Promise<string>` type omits the `undefined` resolution that this script can still produce when `requestUserToken()` resolves without a valid token.

## What this milestone ships

- Domain types and parsers for `Song`, `Recommendation`, and `Feedback`.
- `DeveloperTokenProvider`, implemented by the caller.
- `MusicKitAuthClient` with `configure`, `authorize`, and `unauthorize`.
- `createBrowserMusicKitSession()`, which loads `https://js-cdn.music.apple.com/musickit/v3/musickit.js` and adapts the subset of the SDK used here.
- Node tests for domain parsing, auth success, auth denial, auth error, blank token, provider failure, single-flight concurrency, and the browser loader against a fake DOM.

## Out of scope

- Recommendation ranking, scoring, or fetching `GET /v1/me/recommendations`.
- Playback, queue, heavy rotation, recently played, and any listening or skip counter.
- Server-side signing of developer tokens, and any `.p8` or JWT in the repository.
- A live Apple account login in CI or in these tests.
- Deploy, a demo UI, playlist creation, and `POST /v1/me/library`.
- Disabling or reimplementing the SDK's own `localStorage` persistence.
- Token refresh when a latched developer token expires.

## Approaches

**Minimal wrapper (this milestone).** Plain TypeScript modules. The auth client depends on a narrow session interface. Production code uses the browser adapter. Tests pass a fake session. The repository gains no React app, no server, and no MusicKit npm package.

**Full demo.** An HTML page that loads MusicKit, opens the real authorization popup, and shows library or catalog data. It only works with a developer token and an Apple ID, so its main path cannot be the automated test. It also drags in player and library APIs that this milestone does not need.

## Module layout

Implementation adds these files and leaves the existing README sentence in place. It appends this sentence: "The first code milestone is a MusicKit authorization wrapper (see docs/superpowers/specs/2026-11-20-musickit-auth-design.md) and its tests do not sign in to Apple Music."

```text
package.json
package-lock.json
tsconfig.json
src/index.ts
src/domain/types.ts
src/musickit/errors.ts
src/musickit/auth-client.ts
src/musickit/browser-loader.ts
test/domain.test.ts
test/auth-client.test.ts
test/browser-loader.test.ts
```

`package.json` name is `apple-music-discovery`, `"type": "module"`, private. Runtime dependencies: none. Dev dependency: `typescript`. Scripts:

- `"typecheck": "tsc --noEmit"`
- `"test": "node --test test/domain.test.ts test/auth-client.test.ts test/browser-loader.test.ts"`

`tsconfig.json`: `strict`, `module` and `moduleResolution` `NodeNext`, `target` `ES2022`, `lib` `["ES2022", "DOM"]`, `noEmit` true, `include` `src` and `test`. Node 22.23.4 on the design environment ran a `.ts` file with `node` and no strip flag. The implementation target is that runtime: `node --test` executes the TypeScript tests directly.

`src/index.ts` re-exports the public types and functions listed in this document. Evaluating any module in `src/` does not read `document`, `window`, the network, or `localStorage`. The browser loader reads the document and window only from inside `createBrowserMusicKitSession` and the session methods.

## Domain records

These records are caller-owned data. Nothing in this milestone fills them from Apple.

```ts
export interface Song {
  id: string;
  title: string;
  artistName: string;
  albumTitle?: string;
}

export interface Recommendation {
  id: string;
  title: string;
  songs: readonly Song[];
}

export type FeedbackRating = "up" | "down";

export interface Feedback {
  songId: string;
  rating: FeedbackRating;
  createdAt: string;
}
```

`createdAt` is the exact string `Date.prototype.toISOString()` emits: `YYYY-MM-DDTHH:mm:ss.sssZ`. `parseFeedback` accepts a timestamp only when it matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` and `new Date(value).toISOString()` returns that same string. A calendar rollover such as `2026-02-31T00:00:00.000Z` fails the equality check.

Parsers accept `unknown` and return the interface. They throw `DomainError`. They accept only the keys listed above. `albumTitle` may be absent. Any other key, including `playCount`, `skipped`, `listenedAt`, `score`, or `rank`, throws. An empty `songs` array is valid. Each entry must parse as a `Song`.

String fields are trimmed. A field that is empty after trim throws. Stored values are the trimmed strings. `albumTitle` when present follows the same rule.

```ts
export class DomainError extends Error {
  readonly name = "DomainError";
  readonly code = "INVALID_DOMAIN_VALUE";
  readonly path: string;
  constructor(path: string, message: string);
}
```

`path` is `$` when the root value is not an object, `songs` when that field is not an array, `songs[<index>]` when an entry is not an object, and otherwise the failing field, such as `id`, `songs[0].title`, `rating`, `now`, or `playCount`. `message` is `Invalid <path>.`

```ts
export function parseSong(input: unknown): Song;
export function parseRecommendation(input: unknown): Recommendation;
export function parseFeedback(input: unknown): Feedback;
export function createFeedback(input: {
  songId: string;
  rating: FeedbackRating;
  now: Date;
}): Feedback;
```

`createFeedback` builds `{ songId, rating, createdAt: now.toISOString() }` and returns `parseFeedback` of that object. An invalid `Date` throws `DomainError` at path `now` before parsing. The function does not read the system clock.

## SDK surface the wrapper calls

The browser adapter loads this script once:

```html
<script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js" async></script>
```

Constant `MUSICKIT_SCRIPT_SRC` is that URL. Constant `MUSICKIT_LOADED_EVENT` is `musickitloaded`. Constant `SCRIPT_LOAD_TIMEOUT_MS` is `10000`.

After the document event `musickitloaded`, or immediately when `window.MusicKit` is already defined, the adapter calls:

```ts
const instance = await MusicKit.configure({
  developerToken,
  app: { name: appName, build: appBuild },
});
```

`build` is omitted when the caller omits `appBuild`. `configure` in 3.2526.0 returns the new instance. The adapter keeps that return value. It uses `MusicKit.getInstance()` only as a fallback when `configure` resolves a non-object; `getInstance()` with no argument returns the last instance, or `undefined` when none exists.

The adapter then calls only:

- `instance.authorize(): Promise<string | undefined>`
- `instance.unauthorize(): Promise<unknown>`
- `instance.isAuthorized: boolean`

It does not read `musicUserToken`, and it does not call `api`, `setQueue`, `play`, or `canAuthorize`.

Observed `authorize()` behavior in 3.2526.0, for the security and error mapping:

1. If the SDK already has a non-empty user token, `authorize()` returns that string and does not open a popup.
2. Otherwise the SDK opens `https://authorize.music.apple.com`. The popup message `authorize` with a non-empty token resolves `{ userToken, cid, restricted }`. `decline` rejects with `1`. Window close, an empty token, and `switchUserId` reject with `0`. `unavailable` rejects with `-1`.
3. The public `authorize()` method catches those rejections, calls `unauthorize()`, and throws `MKError` reason `AUTHORIZATION_ERROR`, message `Unauthorized`. The numeric popup code is not visible to our client.
4. A storefront lookup failure after a token was issued calls `unauthorize()` and rejects with that storefront error, which is not rewritten into `AUTHORIZATION_ERROR`.
5. If the internal token request resolves without a non-empty token, `authorize()` resolves `undefined`.

`unauthorize()` revokes the SDK user token and sets the SDK authorization status to `NOT_DETERMINED` (`0`).

SDK status numbers in this build: `UNAVAILABLE = -1`, `NOT_DETERMINED = 0`, `DENIED = 1`, `RESTRICTED = 2`, `AUTHORIZED = 3`. `isAuthorized` is `authorizationStatus > DENIED`, so it is true for both `RESTRICTED` and `AUTHORIZED`. `authorize()` returns a non-empty token for both of those SDK statuses, and the wrapper maps that token to public status `authorized`. `configure()` can also set public status `authorized` when `isAuthorized()` is already true, including when the SDK status is `RESTRICTED`. This milestone has no separate restricted state.

`MKError` extends `Error`. `errorCode` returns `reason`. Reasons observed on the class include `AUTHORIZATION_ERROR`, `CONFIGURATION_ERROR`, `INVALID_ARGUMENTS`, `NETWORK_ERROR`, and `UNAUTHORIZED_ERROR`. HTTP 401 maps to `UNAUTHORIZED_ERROR` inside the SDK. That is a different code from the popup failure `AUTHORIZATION_ERROR`. The wrapper treats only `AUTHORIZATION_ERROR` as denial.

Default SDK persistence in this build is `persist: "localstorage"`. A valid user token is stored under `` `${prefix}.${teamId}.media-user-token` `` with prefix default `music`. The wrapper does not pass `persist`, does not read that key, and does not delete it. On a real page, a later `configure` can therefore already report `isAuthorized === true` because the SDK restored its own storage. `configure()` on the client honors that: public status becomes `authorized` without calling `authorize()`.

The script also auto-configures when a meta tag `apple-music-developer-token` or `JWT` is present. This library must not emit those meta tags.

The docs describe `app.name` as the application name during authorization. In 3.2526.0, `configure` copies `app` onto the SDK config via `Object.assign`, and the popup payload's `thirdPartyName` is `window.location.host`. The wrapper still sends `app.name` because the documented configuration requires it and the script reads it for app identity.

## Session and client interfaces

```ts
export interface DeveloperTokenProvider {
  getDeveloperToken(): string | Promise<string>;
}

export interface MusicKitAuthSession {
  configure(input: {
    developerToken: string;
    app: { name: string; build?: string };
  }): Promise<unknown>;
  authorize(): Promise<string | undefined>;
  unauthorize(): Promise<unknown>;
  isAuthorized(): boolean;
}

export type AuthStatus =
  | "unconfigured"
  | "configured"
  | "authorized"
  | "unauthorized";

export interface AuthorizeResult {
  status: "authorized";
}

export interface UnauthorizeResult {
  status: "unauthorized";
}

export interface MusicKitAuthClientOptions {
  appName: string;
  appBuild?: string;
  tokenProvider: DeveloperTokenProvider;
  session: MusicKitAuthSession;
}

export class MusicKitAuthError extends Error {
  readonly name = "MusicKitAuthError";
  readonly kind: "denied" | "error";
  readonly code: string;
  constructor(
    kind: "denied" | "error",
    code: string,
    message: string,
    options?: { cause?: unknown },
  );
}

export class MusicKitAuthClient {
  constructor(options: MusicKitAuthClientOptions);
  getStatus(): AuthStatus;
  getPending(): "configure" | "authorize" | "unauthorize" | null;
  configure(): Promise<void>;
  authorize(): Promise<AuthorizeResult>;
  unauthorize(): Promise<UnauthorizeResult>;
}
```

`createBrowserMusicKitSession(options?: { document?: Document; window?: Window; timeoutMs?: number }): MusicKitAuthSession`

The factory defaults `document` and `window` to the globals and `timeoutMs` to `10000`. Constructing the session does not load the script. The first `configure` loads it.

### Construction

`appName` must be a non-empty string after trim. Otherwise the constructor throws `MusicKitAuthError` kind `error`, code `MISSING_APP_NAME`, message `App name is empty.` `appBuild` may be omitted. When it is passed, it is trimmed, and an empty result throws kind `error`, code `MISSING_APP_BUILD`, message `App build is empty.` The provider is not called from the constructor.

### Developer token

Each configure attempt calls `tokenProvider.getDeveloperToken()` once. The returned token is trimmed. A later attempt happens only after the previous attempt failed. A non-string or a blank string throws kind `error`, code `MISSING_DEVELOPER_TOKEN`, message `Developer token is empty.`, and does not call `session.configure`. A thrown provider rejects with kind `error`, code `DEVELOPER_TOKEN_PROVIDER_FAILED`, message `Developer token provider failed.`, and `cause` set to the provider's thrown value. The wrapper does not check JWT shape, signature, `exp`, or `origin`.

After `session.configure` resolves, the developer token and app identity are latched in JavaScript private fields (`#developerToken`, `#appName`, `#appBuild`). TypeScript `private` parameter properties are not used for those values, because those compile to enumerable `this` properties. Later `configure()` calls do not call the provider or `session.configure` again and do not change status. A failed attempt is not latched, so the next `configure()` or `authorize()` may call the provider again. Replacing an expired developer token means constructing a new client. The browser session throws kind `error`, code `TOKEN_ALREADY_CONFIGURED`, message `MusicKit session is already configured.` if its own `configure` is invoked again with a different token or app name. A repeated browser `configure` with the same token and app name returns the existing instance.

### Public status

| Status | How it is entered |
| --- | --- |
| `unconfigured` | Constructor only. |
| `configured` | The configuring call found `isAuthorized()` false, and the previous status was `unconfigured`. |
| `authorized` | `authorize()` resolved a non-empty token, or the configuring call found `isAuthorized()` true. |
| `unauthorized` | `unauthorize()` resolved, or `authorize()` ended in denial. A failed `unauthorize()` also enters this status when `isAuthorized()` is false. |

A latched `configure()` does not change status. A configuring call that finds `isAuthorized()` false leaves an existing `unauthorized` status as `unauthorized` rather than moving it to `configured`. Denial and a resolved `unauthorize()` move `authorized` or `configured` to `unauthorized`.

`unauthorize()` before the first successful `session.configure` does not call the session. A following configuring call still trusts `isAuthorized()`. If the SDK restores a stored user and `isAuthorized()` is true, status becomes `authorized`. Clearing that restored SDK session is a later `unauthorize()` after configure has resolved.

`getPending()` is `"configure"` while a standalone `configure()` promise is unsettled. It is `"authorize"` while an `authorize()` promise is unsettled, including when that flight is also configuring or performing a superseded sign-out. It is `"unauthorize"` while an `unauthorize()` promise is unsettled and no authorize promise is unsettled. Otherwise it is `null`. During supersede, authorize and unauthorize promises settle in the same turn, so callers do not observe a separate `"unauthorize"` pending value for that path.

### Data flow

Shared configure promise: the first `configure()` or `authorize()` that needs a session starts one configure attempt. Every caller already waiting for configure awaits that same promise. Rejection clears it so the next call can retry. Resolution latches it.

`authorize()`:

1. Join the in-flight authorize promise when one exists.
2. Otherwise wait until any in-flight `unauthorize()` settles, then run one flight.
3. Await the shared configure promise.
4. If this flight was superseded, skip `session.authorize` and follow the concurrency rule.
5. Otherwise call `session.authorize()` once. Local status does not skip this call.
6. A non-empty string sets status to `authorized` and resolves `{ status: "authorized" }`. The string is not retained, is not put on the result, and is compared only in that turn if an error message must be scrubbed.
7. When the flight was not superseded, `undefined` or `""` is a denial. The client calls `session.unauthorize()` once, ignores a rejection from that call, sets status to `unauthorized`, and throws denial.
8. When the flight was not superseded, a rejection whose SDK code is `AUTHORIZATION_ERROR` is a denial. The client does not call `session.unauthorize` again, because script 3.2526.0 already did. Status becomes `unauthorized`.
9. Any other rejection is kind `error`. Status stays as it was after configure. `session.unauthorize` is not called.

`configure()`:

1. Return the latched promise when configuration already succeeded.
2. Otherwise run the shared configure attempt: provider, then `session.configure` with `{ developerToken, app: { name, build? } }`.
3. `isAuthorized()` true sets status to `authorized`. `isAuthorized()` false sets status to `configured` only from `unconfigured`; from `unauthorized` it stays `unauthorized`.
4. This method does not call `session.authorize` and does not open the authorization popup.

`unauthorize()` with no successful configure and no in-flight authorize: do not call the session, set status to `unauthorized`, resolve `{ status: "unauthorized" }`.

`unauthorize()` when an authorize flight is running: follow the concurrency rules.

`unauthorize()` otherwise: call `session.unauthorize()` once. On resolution, status is `unauthorized` and the result is `{ status: "unauthorized" }`. On rejection, throw kind `error`. Status becomes `authorized` when `isAuthorized()` is true and `unauthorized` when it is false.

### Errors

SDK-shaped rejection: an `Error` or plain object with a string `errorCode` or `reason` matching `^[A-Z0-9_]+$`. Prefer `errorCode` when both are present. Message prefers `description`, then `message`, when that value is a string.

| Condition | kind | code | message |
| --- | --- | --- | --- |
| Blank app name | `error` | `MISSING_APP_NAME` | `App name is empty.` |
| Blank app build, when passed | `error` | `MISSING_APP_BUILD` | `App build is empty.` |
| Blank token | `error` | `MISSING_DEVELOPER_TOKEN` | `Developer token is empty.` |
| Provider throws | `error` | `DEVELOPER_TOKEN_PROVIDER_FAILED` | `Developer token provider failed.` |
| No browser document | `error` | `NOT_IN_BROWSER` | `MusicKit JS requires a browser document.` |
| Script `error` event | `error` | `SCRIPT_LOAD_FAILED` | `MusicKit JS script failed to load.` |
| Load exceeds `timeoutMs` | `error` | `SCRIPT_LOAD_TIMEOUT` | `MusicKit JS did not load within <timeoutMs> milliseconds.` |
| `configure` resolved without an instance | `error` | `NOT_CONFIGURED` | `MusicKit session is not configured.` |
| Second browser `configure` with different identity | `error` | `TOKEN_ALREADY_CONFIGURED` | `MusicKit session is already configured.` |
| `authorize` rejected with `AUTHORIZATION_ERROR`, or resolved empty | `denied` | `AUTHORIZATION_ERROR` | `MusicKit authorization was not granted.` |
| Sign-out wins over in-flight sign-in | `denied` | `AUTHORIZATION_ERROR` | `Authorization superseded by unauthorize.` |
| Any other SDK-shaped rejection | `error` | that SDK code | SDK message, after the token scrub below |
| Any other thrown value | `error` | `UNKNOWN_ERROR` | `MusicKit authorization failed.` |

`UNAUTHORIZED_ERROR` stays kind `error`. It is not denial.

If a message that would be copied onto `MusicKitAuthError` contains the latched developer token or the string just returned by `session.authorize()`, the wrapper replaces that message with the error code. `cause` is the original thrown value when there is one. Callers that log `cause` can still see provider or SDK details, so the fixed `message` is the safe string.

Denial means the wrapper saw `AUTHORIZATION_ERROR` or an empty `authorize()` resolution. In 3.2526.0 that bucket mixes user decline, a closed popup, `unavailable`, and any other failure the public method collapses into `AUTHORIZATION_ERROR`. A mock test can feed that error. It cannot prove which popup control a person clicked. A bad developer token can surface in the same bucket on a live page.

### Concurrency

- At most one call to `session.authorize` or `session.unauthorize` is in flight.
- A second `authorize()` while the first authorize promise is pending returns that same promise.
- A second `unauthorize()` while an unauthorize promise is pending, and authorize is not pending, returns that same promise.
- `authorize()` started during `unauthorize()` waits for that sign-out to settle, then starts one sign-in.
- `unauthorize()` started during `authorize()` sets that flight's supersede flag and waits. The flag starts false at the beginning of each authorize flight. The client does not call `session.unauthorize` until `session.authorize` has settled, except when supersede is set before `session.authorize` is called: then `session.authorize` is skipped.
- If that configure attempt resolved, the client then calls `session.unauthorize` exactly once and ignores the authorize result. A superseded flight does not also take the empty-token denial call. Every joined `authorize()` promise rejects with the superseded denial. `unauthorize()` resolves `{ status: "unauthorized" }` when that call resolves, and status is `unauthorized`.
- If that `session.unauthorize` rejects, `unauthorize()` rejects as kind `error`, every joined `authorize()` promise still rejects with the superseded denial, and status follows the ordinary unauthorize failure rule.
- If the shared configure attempt rejects during a superseded flight, `session.unauthorize` is not called. `authorize()` rejects with that configure error. `unauthorize()` resolves `{ status: "unauthorized" }`. Status is `unauthorized`.

### Browser loader

`configure` on the browser session:

1. Throw `NOT_IN_BROWSER` when no document is available.
2. If `window.MusicKit?.configure` is already a function, skip injection.
3. Otherwise find `script[src="<MUSICKIT_SCRIPT_SRC>"]`. Append one `script` to `document.head` (or `document.documentElement` when head is absent) with `async = true` and that exact `src` when no such element exists.
4. Wait until `window.MusicKit.configure` is a function, or the script element fires `error`, or `timeoutMs` elapses. `musickitloaded` is one way the global becomes defined; if that event fires and `MusicKit.configure` is still not a function, the wait rejects `NOT_CONFIGURED`. Remove the listeners when the wait ends. A script tag that is already present and already failed is not injected again; the wait ends at `timeoutMs` with `SCRIPT_LOAD_TIMEOUT` when `MusicKit.configure` never appears.
5. Call `MusicKit.configure` with the developer token and app identity. Require the resolved value, or else `getInstance()`, to expose `authorize`, `unauthorize`, and an `isAuthorized` boolean. Otherwise throw `NOT_CONFIGURED`.

`authorize`, `unauthorize`, and `isAuthorized` before a successful loader `configure` throw `NOT_CONFIGURED`. `isAuthorized()` on the adapter returns the boolean getter from the SDK instance.

## Security

- The repository stores no developer token, no `.p8`, no Team ID, no key id, and no Music User Token.
- The client keeps the latched developer token in `#developerToken` so it can skip a second `configure` and scrub error text. It does not keep the Music User Token. `JSON.stringify` of `AuthorizeResult` is `{"status":"authorized"}`. `JSON.stringify` on the client returns `{}` because status and the latched identity are JavaScript private fields, not enumerable properties.
- Error `message` values are the fixed strings in the table, or an SDK message that has had the developer token and the authorize return string removed.
- The wrapper does not write `localStorage`, `sessionStorage`, cookies, or meta tags. The SDK, once configured with its default `persist`, can write the Music User Token on a real authorization. That write is SDK behavior outside this wrapper's storage API.
- Tests use the literal fixtures `test-developer-token` and `test-music-user-token`. Those fixtures are not JWTs and are not credentials.

## Tests

All tests run in Node with `node --test`. None open a network connection, none load the Apple script, and none require a secret.

**Domain**

- A full song, a song without `albumTitle`, a recommendation with one song, and a feedback record whose `createdAt` is `2026-11-19T00:00:00.000Z` parse.
- Empty ids, a whitespace title, an empty `albumTitle`, a rating other than `up` or `down`, a timestamp without milliseconds, an extra `playCount` key, and a recommendation whose song is missing `artistName` throw `DomainError` with the path of the bad field.
- `createFeedback` with a fixed `Date` returns that instant from `toISOString()`.

**Auth client success**

- The mock's `isAuthorized()` stays false. `session.authorize` resolves `test-music-user-token`.
- Result is `{ status: "authorized" }` and `getStatus()` is `authorized`. Success does not read `isAuthorized()` after the non-empty token.
- `JSON.stringify(result)` and `JSON.stringify(client)` do not contain `test-music-user-token` or `test-developer-token`.
- `session.unauthorize` is not called.

**Auth client denial**

- Session `authorize` rejects an object `{ name: "MKError", reason: "AUTHORIZATION_ERROR", errorCode: "AUTHORIZATION_ERROR", message: "Unauthorized" }`.
- The thrown `MusicKitAuthError` has kind `denied`, code `AUTHORIZATION_ERROR`, message `MusicKit authorization was not granted.`
- `getStatus()` is `unauthorized`.
- The client does not call `session.unauthorize` on this path, because the flight was not superseded.
- A second case: `authorize` resolves `undefined`. The client calls `session.unauthorize` once and throws the same denial. Status is `unauthorized` even if the mock's `isAuthorized()` stays true.

**Auth client error**

- Session `authorize` rejects `{ reason: "NETWORK_ERROR", errorCode: "NETWORK_ERROR", message: "offline" }`.
- Thrown error has kind `error`, code `NETWORK_ERROR`, message `offline`.
- Status stays `configured` after a successful configure.
- A rejection whose message contains `test-developer-token` produces a `MusicKitAuthError` message of the code only.
- A rejection with code `UNAUTHORIZED_ERROR` has kind `error`.
- Provider throw: code `DEVELOPER_TOKEN_PROVIDER_FAILED`, `session.configure` is not called.
- Provider returns `"   "`: code `MISSING_DEVELOPER_TOKEN`, `session.configure` is not called, `getStatus()` stays `unconfigured`.
- `unauthorize()` before `configure()`, when that later `configure()` sees `isAuthorized()` true, does not call `session.unauthorize` and `getStatus()` ends `authorized`.

**Concurrency**

- Two overlapping `authorize()` calls cause one `session.authorize` call and return the same result.
- `unauthorize()` invoked after `session.authorize` has been entered and before it resolves causes one `session.unauthorize` call, the authorize promise rejects with message `Authorization superseded by unauthorize.`, and the unauthorize promise resolves `{ status: "unauthorized" }`.

**Browser loader, fake document**

- First `configure` appends one script whose `src` is `MUSICKIT_SCRIPT_SRC` and whose `async` is true.
- A new browser session, given a document that already contains a script with `MUSICKIT_SCRIPT_SRC`, does not append another script when `configure` runs.
- When the fake window already has `MusicKit.configure`, no script is appended.
- `MusicKit.configure` receives `{ developerToken: "test-developer-token", app: { name: "apple-music-discovery", build: "test" } }` when build is provided, and receives no `build` key when it is omitted.
- A second `configure` on the same browser session with a different developer token rejects `TOKEN_ALREADY_CONFIGURED` and does not call `MusicKit.configure` again.
- A window that never defines `MusicKit.configure`, with `timeoutMs: 20`, rejects `SCRIPT_LOAD_TIMEOUT`.
- A script `error` event rejects `SCRIPT_LOAD_FAILED`.
- `configure` on a session created with no document, in this Node process, rejects `NOT_IN_BROWSER`.

## Prerequisites for a real authorization

These are operator requirements for a future live run. This milestone's tests do not meet them and do not need them.

- An Apple Developer Program membership, a MusicKit key id, and a MusicKit private key kept outside this repository.
- A developer token signed with ES256, `kid` set to that key id, `iss` set to the 10-character Team ID, `iat` and `exp` set, and `exp` no more than 15777000 seconds after the current time. An `origin` claim should list the page origin when the page is served on the web.
- The page calls `new MusicKitAuthClient({ appName: "apple-music-discovery", tokenProvider, session: createBrowserMusicKitSession() })`, where `tokenProvider` returns that token at runtime.
- The browser can open `https://authorize.music.apple.com`. A blocked popup ends in the denial bucket described above.
- Personalized Apple Music API calls, which this milestone does not make, need an Apple Music subscriber. The wrapper's `authorize()` call is only the SDK sign-in.

## Limits of the green tests

A passing `npm test` shows that the wrapper maps a mock session the way this document says. It does not show that Apple accepted a developer token, that a person completed the popup, or that MusicKit JS 3.2526.0 is still the file behind the v3 URL. Live confirmation is a later run that supplies a developer token from outside the repository and uses a browser. Until that run, `authorized` in the test suite means the mock resolved a non-empty string.

## Decisions for review

1. Ship the minimal wrapper. Do not add a demo page, playback, catalog calls, or playlist writes in this milestone.
2. Treat MusicKit JS v3 script `3.2526.0` as the API source. Popup failure becomes thrown `AUTHORIZATION_ERROR`. An empty `authorize()` resolution is denial too. `UNAUTHORIZED_ERROR` stays an error. Do not depend on `@types/musickit-js`.
3. `denied` means that SDK outcome. It does not record whether the person clicked decline, closed the popup, or presented a bad developer token.
4. Keep the developer token in `#developerToken` only. Do not return or store the Music User Token. Leave the SDK's default `localStorage` persistence unchanged.
5. Do not sign or validate developer JWTs in this repository. The caller supplies the token through `DeveloperTokenProvider`.
6. Domain parsers accept a closed key set. A recommendation may contain zero songs. No score, rank, or listening field exists.
7. `unauthorize()` before the first successful configure does not revoke an SDK session that `configure()` later restores.
8. Overlapping `authorize()` calls share one SDK call. `unauthorize()` during that call supersedes it and invokes `session.unauthorize` once after configure has succeeded.
9. Tests are mocks and a fake DOM. Node `22.23` runs them with `node --test`. The only dev dependency is `typescript`.
