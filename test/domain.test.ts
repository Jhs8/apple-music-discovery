import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DomainError,
  createFeedback,
  parseFeedback,
  parseRecommendation,
  parseSong,
} from "../src/domain/types.ts";

function rejectsPath(run: () => unknown, path: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.name, "DomainError");
    assert.equal(error.code, "INVALID_DOMAIN_VALUE");
    assert.equal(error.path, path);
    assert.equal(error.message, `Invalid ${path}.`);
    return true;
  });
}

test("parseSong trims required strings and keeps an optional album title", () => {
  assert.deepEqual(
    parseSong({
      id: " 1 ",
      title: " Night ",
      artistName: " Ada ",
      albumTitle: " Live ",
    }),
    {
      id: "1",
      title: "Night",
      artistName: "Ada",
      albumTitle: "Live",
    },
  );
});

test("parseSong omits albumTitle when it is absent", () => {
  const song = parseSong({ id: "1", title: "Night", artistName: "Ada" });
  assert.equal("albumTitle" in song, false);
});

test("parseRecommendation accepts an empty song list and a nested song", () => {
  assert.deepEqual(parseRecommendation({ id: "r1", title: "Tonight", songs: [] }), {
    id: "r1",
    title: "Tonight",
    songs: [],
  });
  assert.deepEqual(
    parseRecommendation({
      id: " r2 ",
      title: " Later ",
      songs: [{ id: "1", title: "Night", artistName: "Ada" }],
    }),
    {
      id: "r2",
      title: "Later",
      songs: [{ id: "1", title: "Night", artistName: "Ada" }],
    },
  );
});

test("parseFeedback accepts an explicit rating and a UTC timestamp", () => {
  assert.deepEqual(
    parseFeedback({
      songId: " 9 ",
      rating: "up",
      createdAt: "2026-11-19T00:00:00.000Z",
    }),
    {
      songId: "9",
      rating: "up",
      createdAt: "2026-11-19T00:00:00.000Z",
    },
  );
  assert.equal(
    parseFeedback({
      songId: "9",
      rating: "down",
      createdAt: "2026-11-19T00:00:00.000Z",
    }).rating,
    "down",
  );
});

test("parsers reject closed-key and empty-field violations", () => {
  rejectsPath(() => parseSong(null), "$");
  rejectsPath(() => parseSong([]), "$");
  rejectsPath(() => parseSong({ id: " ", title: "Night", artistName: "Ada" }), "id");
  rejectsPath(() => parseSong({ id: "1", title: " ", artistName: "Ada" }), "title");
  rejectsPath(
    () => parseSong({ id: "1", title: "Night", artistName: "Ada", albumTitle: " " }),
    "albumTitle",
  );
  rejectsPath(
    () => parseSong({ id: "1", title: "Night", artistName: "Ada", playCount: 4 }),
    "playCount",
  );
  rejectsPath(() => parseRecommendation({ id: "r", title: "T", songs: "nope" }), "songs");
  rejectsPath(() => parseRecommendation({ id: "r", title: "T", songs: ["nope"] }), "songs[0]");
  rejectsPath(
    () => parseRecommendation({ id: "r", title: "T", songs: [{ id: "1", title: "Night" }] }),
    "songs[0].artistName",
  );
  rejectsPath(
    () => parseRecommendation({ id: "r", title: "T", score: 1, songs: [] }),
    "score",
  );
  rejectsPath(
    () =>
      parseFeedback({
        songId: "9",
        rating: "skip",
        createdAt: "2026-11-19T00:00:00.000Z",
      }),
    "rating",
  );
  rejectsPath(
    () =>
      parseFeedback({
        songId: "9",
        rating: "up",
        createdAt: "2026-11-19T00:00:00Z",
      }),
    "createdAt",
  );
  rejectsPath(
    () =>
      parseFeedback({
        songId: "9",
        rating: "up",
        createdAt: "2026-02-31T00:00:00.000Z",
      }),
    "createdAt",
  );
  rejectsPath(
    () =>
      parseFeedback({
        songId: "9",
        rating: "up",
        createdAt: "2026-11-19T00:00:00.000Z",
        listenedAt: "2026-11-19T00:00:00.000Z",
      }),
    "listenedAt",
  );
});

test("createFeedback uses the supplied clock", () => {
  assert.deepEqual(
    createFeedback({
      songId: " 9 ",
      rating: "up",
      now: new Date("2026-11-19T00:00:00.000Z"),
    }),
    {
      songId: "9",
      rating: "up",
      createdAt: "2026-11-19T00:00:00.000Z",
    },
  );
});

test("createFeedback rejects an invalid Date before parsing", () => {
  rejectsPath(
    () => createFeedback({ songId: "9", rating: "up", now: new Date(Number.NaN) }),
    "now",
  );
});
