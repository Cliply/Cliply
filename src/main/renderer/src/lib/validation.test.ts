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

import { detectPlatform, isValidPinterestUrl } from "./validation"

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
    expect(detectPlatform("https://www.pinterest.co.uk/pin/123")).toBe("pinterest")
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
