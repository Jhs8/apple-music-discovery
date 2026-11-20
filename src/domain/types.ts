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

export class DomainError extends Error {
  readonly code = "INVALID_DOMAIN_VALUE";
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.path = path;
  }
}

const SONG_KEYS = new Set(["id", "title", "artistName", "albumTitle"]);
const RECOMMENDATION_KEYS = new Set(["id", "title", "songs"]);
const FEEDBACK_KEYS = new Set(["songId", "rating", "createdAt"]);
const CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseSong(input: unknown): Song {
  return parseSongAt(input, "");
}

export function parseRecommendation(input: unknown): Recommendation {
  const record = requireRecord(input, "$");
  rejectUnknownKeys(record, RECOMMENDATION_KEYS, "");
  const songs = record.songs;
  if (!Array.isArray(songs)) {
    fail("songs");
  }
  return {
    id: requireTrimmedString(record.id, "id"),
    title: requireTrimmedString(record.title, "title"),
    songs: songs.map((song, index) => parseSongAt(song, `songs[${index}]`)),
  };
}

export function parseFeedback(input: unknown): Feedback {
  const record = requireRecord(input, "$");
  rejectUnknownKeys(record, FEEDBACK_KEYS, "");
  const rating = record.rating;
  if (rating !== "up" && rating !== "down") {
    fail("rating");
  }
  const createdAt = record.createdAt;
  if (
    typeof createdAt !== "string" ||
    !CREATED_AT.test(createdAt) ||
    new Date(createdAt).toISOString() !== createdAt
  ) {
    fail("createdAt");
  }
  return {
    songId: requireTrimmedString(record.songId, "songId"),
    rating,
    createdAt,
  };
}

export function createFeedback(input: {
  songId: string;
  rating: FeedbackRating;
  now: Date;
}): Feedback {
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    fail("now");
  }
  return parseFeedback({
    songId: input.songId,
    rating: input.rating,
    createdAt: input.now.toISOString(),
  });
}

function parseSongAt(input: unknown, prefix: string): Song {
  const record = requireRecord(input, prefix || "$");
  rejectUnknownKeys(record, SONG_KEYS, prefix);
  const song: Song = {
    id: requireTrimmedString(record.id, fieldPath(prefix, "id")),
    title: requireTrimmedString(record.title, fieldPath(prefix, "title")),
    artistName: requireTrimmedString(record.artistName, fieldPath(prefix, "artistName")),
  };
  if ("albumTitle" in record) {
    song.albumTitle = requireTrimmedString(record.albumTitle, fieldPath(prefix, "albumTitle"));
  }
  return song;
}

function fieldPath(prefix: string, field: string): string {
  return prefix === "" ? field : `${prefix}.${field}`;
}

function requireRecord(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail(path);
  }
  return input as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail(fieldPath(prefix, key));
    }
  }
}

function requireTrimmedString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    fail(path);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    fail(path);
  }
  return trimmed;
}

function fail(path: string): never {
  throw new DomainError(path, `Invalid ${path}.`);
}
