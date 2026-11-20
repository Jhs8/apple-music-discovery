export {
  DomainError,
  createFeedback,
  parseFeedback,
  parseRecommendation,
  parseSong,
} from "./domain/types.ts";
export type { Feedback, FeedbackRating, Recommendation, Song } from "./domain/types.ts";

export { MusicKitAuthClient, MusicKitAuthError } from "./musickit/auth-client.ts";
export type {
  AuthStatus,
  AuthorizeResult,
  DeveloperTokenProvider,
  MusicKitAuthClientOptions,
  MusicKitAuthSession,
  UnauthorizeResult,
} from "./musickit/auth-client.ts";

export {
  MUSICKIT_LOADED_EVENT,
  MUSICKIT_SCRIPT_SRC,
  SCRIPT_LOAD_TIMEOUT_MS,
  createBrowserMusicKitSession,
} from "./musickit/browser-loader.ts";
