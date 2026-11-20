# MusicKit authorization wrapper implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship a TypeScript MusicKit configure/authorize/unauthorize wrapper, closed-key domain parsers, and Node tests that mock the SDK.

**Architecture:** Callers pass a `DeveloperTokenProvider` and a `MusicKitAuthSession`. `MusicKitAuthClient` latches one developer token, maps SDK results onto `authorized` / `denied` / `error`, and serializes authorize and unauthorize. `createBrowserMusicKitSession` is the only module that touches `document`, and only when `configure` runs. Tests inject a fake session or a fake DOM.

**Tech Stack:** Node.js 22.23 (native TypeScript strip), TypeScript strict, `node:test`, no runtime dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-11-20-musickit-auth-design.md`. That document is the behavior source.
- Package name `apple-music-discovery`, `"type": "module"`, `"private": true`. Runtime dependencies: none. Dev dependency: `typescript` only.
- Scripts: `"typecheck": "tsc --noEmit"` and `"test": "node --test test/domain.test.ts test/auth-client.test.ts test/browser-loader.test.ts"`.
- `tsconfig.json`: `strict`, `module` and `moduleResolution` `NodeNext`, `target` `ES2022`, `lib` `["ES2022", "DOM"]`, `noEmit` true, `allowImportingTsExtensions` true. Relative imports use the `.ts` extension because Node 22.23 resolves `./file.ts` and does not map `./file.js` onto `./file.ts`.
- No `.p8`, JWT, Team ID, key id, or real token in git. Test fixtures are the literals `test-developer-token` and `test-music-user-token`.
- Do not read `musicUserToken`, pass `persist`, write storage, or emit `apple-music-developer-token` / `JWT` meta tags.
- SDK storage, documented in the README: script 3.2526.0 defaults `persist` to `localstorage` and can write `` `${prefix}.${teamId}.media-user-token` `` with prefix `music`. This library does not read or delete that key.
- Mock tests are not a live Apple login.
- Execution stays on branch `cursor/musickit-auth-design-8e61` and pull request https://github.com/Jhs8/apple-music-discovery/pull/1. Do not merge.

---

### Task 1: Package scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Modify: none

**Interfaces:**
- Consumes: none
- Produces: `npm test` and `npm run typecheck` entry points

- [x] **Step 1: Add the package files**

`package.json` names the package, sets `"type": "module"`, and declares the two scripts above. `.gitignore` contains `node_modules/`.

- [x] **Step 2: Install and record the lockfile**

Run: `npm install`
Expected: `package-lock.json` created, `typescript` under `devDependencies`.

- [x] **Step 3: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore docs/superpowers/plans/2026-11-20-musickit-auth.md
git commit -m "Add the TypeScript test scaffold and implementation plan."
```

### Task 2: Domain parsers

**Files:**
- Create: `src/domain/types.ts`
- Test: `test/domain.test.ts`

**Interfaces:**
- Consumes: none
- Produces: `Song`, `Recommendation`, `Feedback`, `FeedbackRating`, `DomainError`, `parseSong`, `parseRecommendation`, `parseFeedback`, `createFeedback`

- [x] **Step 1: Write the failing test**

Cover, with `node:assert/strict` and `node:test`:

- `parseSong` trims `id`, `title`, and `artistName`, keeps `albumTitle` when present, and omits `albumTitle` when absent.
- `parseRecommendation` accepts `songs: []` and a nested song.
- `parseFeedback` accepts `createdAt` `2026-11-19T00:00:00.000Z` and ratings `up` and `down`.
- Rejections use `DomainError`, `code` `INVALID_DOMAIN_VALUE`, and `message` `Invalid <path>.`:
  - non-object song path `$`
  - empty id path `id`
  - whitespace title path `title`
  - empty `albumTitle` path `albumTitle`
  - extra `playCount` path `playCount`
  - `songs` not an array path `songs`
  - `songs[0]` not an object path `songs[0]`
  - missing `artistName` path `songs[0].artistName`
  - rating `skip` path `rating`
  - `2026-11-19T00:00:00Z` path `createdAt`
  - `2026-02-31T00:00:00.000Z` path `createdAt`
- `createFeedback({ songId: " 9 ", rating: "up", now: new Date("2026-11-19T00:00:00.000Z") })` returns the trimmed id and that exact `createdAt`.
- `createFeedback` with `new Date(Number.NaN)` throws path `now`.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test test/domain.test.ts`
Expected: FAIL because `src/domain/types.ts` does not exist.

- [x] **Step 3: Write minimal implementation**

`DomainError` sets `name`, `code`, and `path`. Parsers accept only their listed keys. Strings are trimmed and rejected when empty. `createFeedback` rejects an invalid `Date` at path `now`, then returns `parseFeedback`.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test test/domain.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/domain/types.ts test/domain.test.ts
git commit -m "Add closed-key song, recommendation, and feedback parsers."
```

### Task 3: Auth client

**Files:**
- Create: `src/musickit/errors.ts`, `src/musickit/auth-client.ts`
- Test: `test/auth-client.test.ts`

**Interfaces:**
- Consumes: none from Task 2
- Produces: `DeveloperTokenProvider`, `MusicKitAuthSession`, `AuthStatus`, `AuthorizeResult`, `UnauthorizeResult`, `MusicKitAuthError`, `MusicKitAuthClient`

`MusicKitAuthError` stores `kind` and `code` on the instance, sets `name` to `MusicKitAuthError`, and passes `{ cause }` to `super` only when `cause` is present.

Client state uses JavaScript private fields only: `#appName`, `#appBuild`, `#tokenProvider`, `#session`, `#status`, `#developerToken`, `#latched`, `#configurePromise`, `#authorizeFlight`, `#unauthorizeFlight`, `#supersede`, `#supersedeWait`. `JSON.stringify(client)` is `{}`.

Configure attempts share one promise. A rejection clears it. A resolution latches it and skips later provider calls. `authorize()` joins `#authorizeFlight`. `unauthorize()` joins `#unauthorizeFlight` only when no authorize flight exists. An unauthorize call during an authorize flight sets `#supersede` and returns one deferred. That deferred resolves `{ status: "unauthorized" }` after exactly one `session.unauthorize()` when configure succeeded, or without a session call when configure rejected. The authorize promise rejects with `Authorization superseded by unauthorize.` when configure succeeded, and with the configure error when configure failed. A superseded flight does not also unauthorize for an empty token.

Status rules match the spec table. `getPending()` prefers `authorize`, then `unauthorize`, then `configure` while the configure promise is unsettled.

SDK errors: prefer string `errorCode`, else string `reason`, when the value matches `/^[A-Z0-9_]+$/`. Message prefers `description`, then `message`. `AUTHORIZATION_ERROR` is `denied` with message `MusicKit authorization was not granted.` Any other SDK code is `error`. A message containing the developer token or the string just returned by `authorize()` is replaced by the code. Non-SDK throws become `UNKNOWN_ERROR` / `MusicKit authorization failed.`

- [x] **Step 1: Write the failing test**

Use a controllable fake session (`configure`, `authorize`, `unauthorize`, `isAuthorized`, plus call counts and deferred authorize). Assert every auth case in the spec's Tests section, plus constructor rejection for a blank `appName` and a blank `appBuild`, and one overlapping `configure()` pair that calls the provider once.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test test/auth-client.test.ts`
Expected: FAIL because the client module does not exist.

- [x] **Step 3: Write minimal implementation**

Implement the private-field client and the error class described above. The exclusive queue is reentrant so `authorize()` can call `configure()` without deadlocking.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test test/auth-client.test.ts test/domain.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/musickit/errors.ts src/musickit/auth-client.ts test/auth-client.test.ts
git commit -m "Add the MusicKit auth client and mock session tests."
```

### Task 4: Browser loader

**Files:**
- Create: `src/musickit/browser-loader.ts`
- Test: `test/browser-loader.test.ts`

**Interfaces:**
- Consumes: `MusicKitAuthSession`, `MusicKitAuthError`
- Produces: `MUSICKIT_SCRIPT_SRC` = `https://js-cdn.music.apple.com/musickit/v3/musickit.js`, `MUSICKIT_LOADED_EVENT` = `musickitloaded`, `SCRIPT_LOAD_TIMEOUT_MS` = `10000`, `createBrowserMusicKitSession`

The factory does not read `document` or `window`. `configure` does.

Load order: throw `NOT_IN_BROWSER` when no document is available; skip injection when `window.MusicKit.configure` is already a function; otherwise reuse `script[src="<MUSICKIT_SCRIPT_SRC>"]` or append one `async` script to `head`, or to `documentElement` when `head` is absent. Wait until `MusicKit.configure` is a function, the script fires `error` (`SCRIPT_LOAD_FAILED`), or `timeoutMs` elapses (`SCRIPT_LOAD_TIMEOUT`, message includes the millisecond count). If `musickitloaded` fires and `configure` is still missing, reject `NOT_CONFIGURED`. Remove listeners when the wait ends.

Call `MusicKit.configure` with `{ developerToken, app: { name, build? } }`. `build` is omitted when absent. Keep the returned instance when it exposes `authorize`, `unauthorize`, and a boolean `isAuthorized`; otherwise use `getInstance()`. A second configure with the same token and app identity returns that instance. A different identity throws `TOKEN_ALREADY_CONFIGURED` and does not call `MusicKit.configure` again. `authorize`, `unauthorize`, and `isAuthorized` before configure throw `NOT_CONFIGURED`.

- [x] **Step 1: Write the failing test**

Fake `document` and `window` in the test file. Assert the browser cases in the spec, including no second script tag, no injection when `MusicKit.configure` already exists, build present and omitted, `TOKEN_ALREADY_CONFIGURED`, `timeoutMs: 20`, a script `error` event, and `NOT_IN_BROWSER` with no document.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test test/browser-loader.test.ts`
Expected: FAIL because the loader module does not exist.

- [x] **Step 3: Write minimal implementation**

Implement the loader. Do not read `musicUserToken` or set `persist`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS for domain, auth client, and browser loader.

- [x] **Step 5: Commit**

```bash
git add src/musickit/browser-loader.ts test/browser-loader.test.ts
git commit -m "Add the MusicKit browser session loader."
```

### Task 5: Public exports, README, and CI

**Files:**
- Create: `src/index.ts`, `.github/workflows/test.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: every public export from Tasks 2–4
- Produces: the package entry and a workflow that runs `npm ci`, `npm run typecheck`, and `npm test` on Node 22

- [x] **Step 1: Re-export the public API**

`src/index.ts` re-exports the domain parsers and types, the auth client and error types, and the browser loader constants and factory. Importing it must not touch `document`.

- [x] **Step 2: Update the README**

Keep the existing first sentence. Append: `The first code milestone is a MusicKit authorization wrapper (see docs/superpowers/specs/2026-11-20-musickit-auth-design.md) and its tests do not sign in to Apple Music.`

Then document the exported functions, a runtime token-provider example that does not contain a real token, the Apple Developer prerequisites, and two explicit labels:

- Mock validation: `npm test` drives a fake session and a fake DOM.
- Live Apple integration: not exercised here. A green test does not mean Apple accepted a developer token or a person finished the popup. On a real page the SDK may store the Music User Token in `localStorage` under its own key.

- [x] **Step 3: Add CI and verify from a clean install**

Workflow triggers on push and pull_request. Then run:

```bash
rm -rf node_modules
npm ci
npm run typecheck
npm test
```

Expected: typecheck exits 0 and every test passes.

- [x] **Step 4: Commit and push**

```bash
git add src/index.ts README.md .github/workflows/test.yml
git commit -m "Export the wrapper, document mock versus live auth, and run CI."
git push origin cursor/musickit-auth-design-8e61
```

Update pull request #1 so the body describes the code, the fresh command results, and the live-auth limit.
