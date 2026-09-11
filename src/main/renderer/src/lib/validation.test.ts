/**
 * what a link has to look like to be accepted.
 *
 * these are about the shapes people actually paste rather than the canonical
 * one: pinterest redirects users to their own country's domain, so the link in
 * someone's clipboard is far more often ru.pinterest.com or pinterest.co.uk
 * than the www.pinterest.com the docs show.
 *
 * the lookalike cases matter as much as the working ones. widening a host
 * pattern is exactly how pinterest.com.evil.com/pin/1 starts being treated as
 * pinterest, so each widening here is paired with the thing it must not admit.
 */

import { describe, expect, it } from "vitest"

import {
  detectPlatform,
  detectYouTubeTarget,
  isValidYouTubePlaylistUrl,
  isValidYouTubeUrl,
  isValidPinterestUrl
} from "./validation"

describe("pinterest links", () => {
  it.each([
    "https://pin.it/1a2b3c4",
    "https://www.pinterest.com/pin/1234567890/",
    "https://pinterest.com/pin/1234567890/",
    "https://www.pinterest.com/pin/1234567890/?utm_source=share"
  ])("takes the shapes it always took: %s", (url) => {
    expect(isValidPinterestUrl(url)).toBe(true)
  })

  // pinterest sends people to their own country's domain, so this is what a
  // real clipboard holds
  it.each([
    "https://ru.pinterest.com/pin/1234567890/",
    "https://in.pinterest.com/pin/1234567890/",
    "https://www.pinterest.co.uk/pin/1234567890/",
    "https://www.pinterest.de/pin/1234567890/",
    "https://www.pinterest.ca/pin/1234567890/",
    "https://www.pinterest.com.mx/pin/1234567890/",
    "https://br.pinterest.com/pin/1234567890/"
  ])("takes a country domain: %s", (url) => {
    expect(isValidPinterestUrl(url)).toBe(true)
  })

  // youtube's validator has always accepted a bare host, and a link pasted
  // out of a chat window frequently arrives without one
  it.each([
    "pinterest.com/pin/1234567890",
    "www.pinterest.com/pin/1234567890",
    "ru.pinterest.com/pin/1234567890",
    "pin.it/1a2b3c4"
  ])("takes a link with no protocol: %s", (url) => {
    expect(isValidPinterestUrl(url)).toBe(true)
  })

  // the whole risk of widening the host: a domain that merely contains the
  // word must not become pinterest
  it.each([
    "https://pinterest.com.evil.com/pin/1234567890",
    "https://notpinterest.com/pin/1234567890",
    "https://pinterest.evil.com/pin/1234567890",
    "https://evil.com/redirect?to=pinterest.com/pin/123",
    "https://pin.it.evil.com/1a2b3c4"
  ])("refuses a host that only looks like pinterest: %s", (url) => {
    expect(isValidPinterestUrl(url)).toBe(false)
  })

  it.each([
    "https://www.pinterest.com/username/boardname/",
    "https://www.pinterest.com/",
    "https://www.pinterest.com/pin/",
    "not a url at all",
    ""
  ])("refuses what is not a pin: %s", (url) => {
    expect(isValidPinterestUrl(url)).toBe(false)
  })

  it("routes a country domain to pinterest and nothing else", () => {
    expect(detectPlatform("https://ru.pinterest.com/pin/123")).toBe("pinterest")
    expect(detectPlatform("https://www.pinterest.co.uk/pin/123")).toBe(
      "pinterest"
    )
  })
})

// the other two validators are untouched by this change; these hold them to
// that, because detectPlatform tries them in order against the same string
describe("the platforms it must not steal", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://youtu.be/dQw4w9WgXcQ", "youtube"],
    ["youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://www.youtube.com/shorts/abc123", "youtube"],
    ["https://www.tiktok.com/@someone/video/1234567890", "tiktok"],
    ["https://vm.tiktok.com/ABC123/", "tiktok"]
  ])("still routes %s to %s", (url, platform) => {
    expect(detectPlatform(url)).toBe(platform)
  })

  it("still refuses a site nobody supports", () => {
    expect(detectPlatform("https://vimeo.com/123456")).toBeNull()
  })
})

/**
 * a playlist link was refused at the input until now: YOUTUBE_URL_REGEX asks
 * for /watch, /embed, /v, /shorts or youtu.be, and a bare playlist link is
 * none of them. the same lookalike discipline as pinterest applies - the
 * hostname is read at its end, never as a substring.
 */
describe("playlist links", () => {
  it.each([
    "https://www.youtube.com/playlist?list=PLLojVvWCZ5N4",
    "https://youtube.com/playlist?list=PLLojVvWCZ5N4",
    // the share sheet's own shape, with its tracking parameter first
    "https://www.youtube.com/playlist?si=abc123&list=PLLojVvWCZ5N4",
    "https://m.youtube.com/playlist?list=PLLojVvWCZ5N4",
    "https://music.youtube.com/playlist?list=OLAK5uy_abc",
    // pasted out of a chat window, which drops the protocol
    "youtube.com/playlist?list=PLLojVvWCZ5N4",
    "www.youtube.com/playlist?list=PLLojVvWCZ5N4"
  ])("takes a playlist link: %s", (url) => {
    expect(isValidYouTubePlaylistUrl(url)).toBe(true)
    // and the input the user types into accepts it, which is the whole point
    expect(isValidYouTubeUrl(url)).toBe(true)
    expect(detectPlatform(url)).toBe("youtube")
  })

  it.each([
    "https://youtube.com.evil.com/playlist?list=PL123",
    "https://notyoutube.com/playlist?list=PL123",
    "https://evil.com/redirect?to=youtube.com/playlist?list=PL123",
    "https://www.youtube.com/playlist",
    "https://www.youtube.com/playlist?list=",
    "not a url at all",
    ""
  ])("refuses what is not a playlist link: %s", (url) => {
    expect(isValidYouTubePlaylistUrl(url)).toBe(false)
  })

  it("does not call a plain video a playlist", () => {
    expect(
      isValidYouTubePlaylistUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    ).toBe(false)
  })
})

/**
 * which of the two things a youtube link points at.
 *
 * `both` is the mixed link, and this ticket only has to *classify* it: the
 * caller still sends it down the single-video path, which is what it has always
 * done. the prompt that asks the user is a later ticket, and it needs this
 * answer to exist first.
 */
describe("detectYouTubeTarget", () => {
  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/abc123",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "youtube.com/watch?v=dQw4w9WgXcQ"
  ])("calls a plain video a video: %s", (url) => {
    const target = detectYouTubeTarget(url)

    expect(target.kind).toBe("video")
    expect(target.videoId).toBeTruthy()
    expect(target.listId).toBeNull()
  })

  it.each([
    "https://www.youtube.com/playlist?list=PLLojVvWCZ5N4",
    "youtube.com/playlist?list=PLLojVvWCZ5N4",
    "https://www.youtube.com/playlist?si=abc&list=PLLojVvWCZ5N4"
  ])("calls a plain playlist a playlist: %s", (url) => {
    const target = detectYouTubeTarget(url)

    expect(target.kind).toBe("playlist")
    expect(target.videoId).toBeNull()
    expect(target.listId).toBe("PLLojVvWCZ5N4")
  })

  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLLojVvWCZ5N4",
    "https://www.youtube.com/watch?list=PLLojVvWCZ5N4&v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?list=PLLojVvWCZ5N4",
    "youtube.com/watch?v=dQw4w9WgXcQ&list=PLLojVvWCZ5N4&index=2"
  ])("calls a link carrying both both: %s", (url) => {
    const target = detectYouTubeTarget(url)

    expect(target.kind).toBe("both")
    expect(target.videoId).toBe("dQw4w9WgXcQ")
    expect(target.listId).toBe("PLLojVvWCZ5N4")
  })

  // a list parameter on somebody else's domain is not our playlist, and a
  // caller routing on `kind` must never be sent to the playlist path by one
  it.each([
    "https://vimeo.com/watch?v=abc&list=PL123",
    "https://evil.com/?list=PL123",
    "not a url at all"
  ])("keeps a link that is not youtube's on the video path: %s", (url) => {
    const target = detectYouTubeTarget(url)

    expect(target.kind).toBe("video")
    expect(target.listId).toBeNull()
  })
})
