# apple-music-discovery

Planning-stage Apple Music discovery companion: personalized ranking, explicit feedback, and reproducible recommendation evaluation.

The first code milestone is a MusicKit authorization wrapper (see docs/superpowers/specs/2026-11-20-musickit-auth-design.md) and its tests do not sign in to Apple Music.

This package is a small TypeScript library. It validates caller-owned song, recommendation, and feedback records, and it wraps MusicKit on the Web configure, authorize, and unauthorize. It does not rank music, fetch recommendations, record listening, or produce audio embeddings.

## Exported API

Import from `src/index.ts` with Node.js 22.23 or newer:

```ts
import {
  MusicKitAuthClient,
  createBrowserMusicKitSession,
  createFeedback,
  parseSong,
} from "./src/index.ts";
```

| Export | Role |
| --- | --- |
| `parseSong`, `parseRecommendation`, `parseFeedback` | Accept `unknown` and return a closed-key record, or throw `DomainError`. |
| `createFeedback` | Builds explicit up/down feedback from a caller-supplied `Date`. |
| `MusicKitAuthClient` | Calls `configure`, `authorize`, and `unauthorize` on an injected session. |
| `MusicKitAuthError` | `kind` is `denied` or `error`. `code` is the stable reason. |
| `createBrowserMusicKitSession` | Loads `https://js-cdn.music.apple.com/musickit/v3/musickit.js` when `configure` runs. |
| `MUSICKIT_SCRIPT_SRC` | That script URL. |

`Song` has `id`, `title`, `artistName`, and optional `albumTitle`. `Recommendation` has `id`, `title`, and `songs`. `Feedback` has `songId`, `rating` (`"up"` or `"down"`), and a UTC `createdAt`. Extra keys, including play counts and listen times, are rejected.

## Example

The token below is not a credential. Replace `getDeveloperToken` with a value your own process supplies at runtime.

```ts
import {
  MusicKitAuthClient,
  createBrowserMusicKitSession,
  createFeedback,
  parseSong,
} from "./src/index.ts";

const client = new MusicKitAuthClient({
  appName: "apple-music-discovery",
  tokenProvider: {
    getDeveloperToken() {
      throw new Error("Pass a MusicKit developer token in at runtime. Do not commit it.");
    },
  },
  session: createBrowserMusicKitSession(),
});

const song = parseSong({
  id: "123",
  title: "Example",
  artistName: "Example Artist",
});

const feedback = createFeedback({
  songId: song.id,
  rating: "up",
  now: new Date("2026-11-19T00:00:00.000Z"),
});
```

`client.authorize()` resolves `{ status: "authorized" }` after the SDK returns a non-empty user token. The result does not include that token. `client.unauthorize()` resolves `{ status: "unauthorized" }`.

## Prerequisites for a live browser sign-in

- An Apple Developer Program membership and a MusicKit private key kept outside this repository.
- A developer token signed with ES256. The header `kid` is the key id. The payload `iss` is the 10-character Team ID. Set `iat` and `exp`, and keep `exp` within 15777000 seconds of the current time. An `origin` claim should list the page origin.
- A page that constructs `MusicKitAuthClient` with `createBrowserMusicKitSession()` and a `DeveloperTokenProvider` that returns that token.
- A browser that can open `https://authorize.music.apple.com`.

## Mock validation and live Apple integration

**Mock validation.** `npm test` runs `node --test` against a fake session and a fake document. `npm run typecheck` runs `tsc --noEmit`. A green run checks status changes, denial, SDK errors, single-flight authorize, and script setup. The fixtures `test-developer-token` and `test-music-user-token` are literal test strings, not Apple credentials.

**Live Apple integration.** Not tested. A green `npm test` does not show that Apple accepted a developer token, that a person finished the authorization popup, or that the current bytes at the v3 script URL are still MusicKit JS 3.2526.0. The behavior in the design spec was read from that build on 2026-11-19.

## SDK-managed storage

This library does not write `localStorage`, `sessionStorage`, cookies, or a developer-token meta tag. It does not read `musicUserToken`. MusicKit JS 3.2526.0 defaults `persist` to `localstorage` and, after a real authorization, can store the Music User Token at ``music.<teamId>.media-user-token``. The wrapper does not pass `persist`, and it does not read or delete that key. `unauthorize()` calls the SDK method, which clears the SDK session. Calling `unauthorize()` before the first successful `configure()` does not clear a token the SDK may restore when `configure()` later runs.
