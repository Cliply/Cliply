// the download id arrives from the renderer, so it is untrusted input

const { resolveDownloadId } = require("../src/main/utils/download-id")

describe("resolveDownloadId", () => {
  test("keeps the id the renderer generated", () => {
    const id = "0f9a1f6c-2b1e-4a3f-9f1a-2c3d4e5f6a7b"

    expect(resolveDownloadId(id, "audio")).toBe(id)
  })

  // trimming would be the same silent substitution the rejection exists to
  // prevent: main would emit under "abc-123" while the renderer filters on
  // "  abc-123  " and matches nothing
  test("rejects a padded id rather than trimming it", () => {
    expect(resolveDownloadId("  abc-123  ", "audio")).toBeNull()
    expect(resolveDownloadId("abc-123 ", "audio")).toBeNull()
    expect(resolveDownloadId(" abc-123", "audio")).toBeNull()
  })

  test("returns the id byte for byte", () => {
    const id = "Combined_9f.8:7-6"

    expect(resolveDownloadId(id, "audio")).toBe(id)
  })

  test("generates a unique id when none was sent", () => {
    const first = resolveDownloadId(undefined, "audio")
    const second = resolveDownloadId(undefined, "audio")

    expect(first).toMatch(/^audio_/)
    expect(first).not.toBe(second)
  })

  test("treats an empty string as no id at all", () => {
    expect(resolveDownloadId("", "combined")).toMatch(/^combined_/)
  })

  // rejected rather than replaced: the renderer filters events on the id it
  // generated, so quietly substituting ours would run an unwatched download
  test.each([
    ["a newline", "abc\ndef"],
    ["a tab", "abc\tdef"],
    ["a control character", "abc\u0007def"],
    ["a space", "abc def"],
    ["a slash", "../../etc/passwd"],
    ["whitespace only", "   "],
    ["something too long", "a".repeat(129)]
  ])("rejects an id with %s", (_label, value) => {
    expect(resolveDownloadId(value, "audio")).toBeNull()
  })

  test.each([
    ["a number", 42],
    ["an object", { id: "abc" }],
    ["an array", ["abc"]],
    ["a boolean", true]
  ])("rejects %s", (_label, value) => {
    expect(resolveDownloadId(value, "audio")).toBeNull()
  })

  test("accepts an id at the length limit", () => {
    const id = "a".repeat(128)

    expect(resolveDownloadId(id, "audio")).toBe(id)
  })
})
