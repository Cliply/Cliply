// @vitest-environment jsdom
//
// the translation layer is 60 lines with no library under it, so the things
// that would normally be someone else's problem - a key that exists in one
// dictionary and not the other, russian's third plural form, a stored choice
// losing to the system locale - are ours.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { en } from "./en"
import { ru } from "./ru"

const freshStore = async () => {
  vi.resetModules()

  return import("./index")
}

// node 25 defines a `localStorage` global with none of the methods on it, and
// it shadows jsdom's, so the real one is not reachable here. an explicit stub
// is clearer anyway: each test says what was on disk when the app started
const memoryStorage = (seed?: string) => {
  const entries = new Map<string, string>(
    seed === undefined ? [] : [["cliply-locale", seed]]
  )

  const storage = {
    length: 0,
    key: () => null,
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key)
  }
  vi.stubGlobal("localStorage", storage)

  return storage
}

beforeEach(() => {
  memoryStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ru.ts is `Record<Key, string>`, so tsc already refuses a missing key. this
// catches the other direction, and catches it when someone reaches for a cast
describe("the two dictionaries", () => {
  test("hold exactly the same keys", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort())
  })

  test("leave no value empty", () => {
    expect(Object.entries(ru).filter(([, value]) => !value.trim())).toEqual([])
  })

  // a russian plural set that forgot a form would silently render the wrong
  // one, since `t` falls back to the last
  test("give every english plural set three forms in russian", () => {
    for (const [key, value] of Object.entries(en)) {
      if (!value.includes("|")) continue

      expect([key, value.split("|").length]).toEqual([key, 2])
      expect([key, ru[key as keyof typeof en].split("|").length]).toEqual([
        key,
        3
      ])
    }
  })
})

describe("detectLocale", () => {
  test.each([
    ["ru-RU", "ru"],
    ["ru", "ru"],
    ["RU", "ru"],
    ["en-GB", "en"],
    // ukrainian is its own language; the toggle is how a ukrainian speaker who
    // reads russian gets there
    ["uk", "en"],
    [undefined, "en"]
  ])("%s resolves to %s", async (language, expected) => {
    const { detectLocale } = await freshStore()

    expect(detectLocale(language)).toBe(expected)
  })
})

describe("the locale the store starts on", () => {
  test("follows the system when nothing was chosen before", async () => {
    vi.stubGlobal("navigator", { language: "ru-RU" })

    const { useLocale } = await freshStore()

    expect(useLocale.getState().locale).toBe("ru")
  })

  test("prefers a stored choice over the system", async () => {
    memoryStorage("en")
    vi.stubGlobal("navigator", { language: "ru-RU" })

    const { useLocale } = await freshStore()

    expect(useLocale.getState().locale).toBe("en")
  })

  test("ignores a stored value that is not a locale", async () => {
    memoryStorage("kl")
    vi.stubGlobal("navigator", { language: "ru-RU" })

    const { useLocale } = await freshStore()

    expect(useLocale.getState().locale).toBe("ru")
  })

  // no storage at all, which is what running outside a browser looks like
  test("survives having nowhere to read from", async () => {
    vi.stubGlobal("localStorage", undefined)
    vi.stubGlobal("navigator", { language: "ru-RU" })

    const { useLocale } = await freshStore()

    expect(useLocale.getState().locale).toBe("ru")
    expect(() => useLocale.getState().setLocale("en")).not.toThrow()
  })

  test("records the choice for the next launch, and on <html>", async () => {
    const storage = memoryStorage()
    const { useLocale } = await freshStore()

    useLocale.getState().setLocale("ru")

    expect(storage.getItem("cliply-locale")).toBe("ru")
    expect(document.documentElement.lang).toBe("ru")
  })
})

describe("t", () => {
  test("returns the dictionary for the current locale", async () => {
    const { t, useLocale } = await freshStore()

    expect(t("hero.tagline")).toBe(en["hero.tagline"])

    useLocale.getState().setLocale("ru")

    expect(t("hero.tagline")).toBe(ru["hero.tagline"])
  })

  test("substitutes params by name", async () => {
    const { t } = await freshStore()

    expect(t("cookies.count", { n: 4 })).toBe("4 cookies")
  })

  // english has two forms, so `other` covers everything that is not exactly 1
  test.each([
    [1, "1 cookie"],
    [0, "0 cookies"],
    [2, "2 cookies"]
  ])("picks the english form for %i", async (n, expected) => {
    const { t } = await freshStore()

    expect(t("cookies.count", { n })).toBe(expected)
  })

  // russian agreement is on the last digit, not the magnitude: 21 takes the
  // same form as 1, 22 the same as 2, and everything from 5 to 20 takes the
  // third
  //
  // asked of the day count rather than the cookie count: `cookies.count` keeps
  // the word latin and undeclined, so its three forms are identical and would
  // pass this whichever one the selector reached for
  test.each([
    [1, "импортировано 1 день назад"],
    [2, "импортировано 2 дня назад"],
    [5, "импортировано 5 дней назад"],
    [0, "импортировано 0 дней назад"],
    [21, "импортировано 21 день назад"],
    [22, "импортировано 22 дня назад"],
    [25, "импортировано 25 дней назад"]
  ])("picks the russian form for %i", async (n, expected) => {
    const { t, useLocale } = await freshStore()
    useLocale.getState().setLocale("ru")

    expect(t("cookies.importedDaysAgo", { n })).toBe(expected)
  })

  // russian's `other` is for fractions, which no count of ours ever is. it has
  // no form in the dictionary, so it must not render an empty string
  test("falls back to the last form for an unlisted category", async () => {
    const { t, useLocale } = await freshStore()
    useLocale.getState().setLocale("ru")

    expect(t("cookies.importedDaysAgo", { n: 1.5 })).toBe(
      "импортировано 1.5 дней назад"
    )
  })

  // the cookie count is the other shape: latin, undeclined, and the same in
  // every form, which is the thing that would silently rot if someone
  // "corrected" it back into a declined russian noun
  test.each([[1], [2], [5], [21]])(
    "counts cookies in latin whatever the number, for %i",
    async (n) => {
      const { t, useLocale } = await freshStore()
      useLocale.getState().setLocale("ru")

      expect(t("cookies.count", { n })).toBe(`${n} cookies`)
    }
  )
})

/**
 * the playlist screens count things in almost every sentence they say, which
 * makes them the heaviest user of the plural machinery in the app.
 *
 * russian agrees on the last digit rather than on the magnitude, so the cases
 * that matter are 1 and 21 (`one`), 2 (`few`) and 5, 11, 100 (`many`) - 11 in
 * particular, because it ends in a 1 and still takes the third form.
 */
describe("the playlist plurals", () => {
  const inEnglish = async () => (await freshStore()).t

  const inRussian = async () => {
    const { t, useLocale } = await freshStore()
    useLocale.getState().setLocale("ru")

    return t
  }

  test.each([
    [1, "1 video"],
    [2, "2 videos"],
    [5, "5 videos"],
    [11, "11 videos"],
    [21, "21 videos"],
    [100, "100 videos"]
  ])("english counts %i videos", async (n, expected) => {
    expect((await inEnglish())("playlist.videoCount", { n })).toBe(expected)
  })

  // «видео» does not decline, so every form is the same word. the point of
  // asserting it is that it stays that way rather than being "corrected" into
  // a declined noun by someone reading the forms beside it
  test.each([[1], [2], [5], [11], [21], [100]])(
    "russian counts %i видео without declining it",
    async (n) => {
      expect((await inRussian())("playlist.videoCount", { n })).toBe(`${n} видео`)
    }
  )

  test.each([
    [1, "Download 1 track"],
    [2, "Download 2 tracks"],
    [100, "Download 100 tracks"]
  ])("english offers to download %i", async (n, expected) => {
    expect((await inEnglish())("playlist.downloadTracks", { n })).toBe(expected)
  })

  // the one russian noun on these screens that really does decline
  test.each([
    [1, "скачать 1 дорожку"],
    [2, "скачать 2 дорожки"],
    [5, "скачать 5 дорожек"],
    [11, "скачать 11 дорожек"],
    [21, "скачать 21 дорожку"],
    [100, "скачать 100 дорожек"]
  ])("russian declines the track count for %i", async (n, expected) => {
    expect((await inRussian())("playlist.downloadTracks", { n })).toBe(expected)
  })

  /**
   * english says the same thing about one failure and about five, so it has
   * no plural set at all here. russian still picks a form, which is the shape
   * `support.title` already has and the one `t` has to keep handling.
   */
  test.each([
    [1, "повторить 1 загрузку"],
    [2, "повторить 2 загрузки"],
    [5, "повторить 5 загрузок"],
    [11, "повторить 11 загрузок"],
    [21, "повторить 21 загрузку"],
    [100, "повторить 100 загрузок"]
  ])("russian declines the retry count for %i", async (n, expected) => {
    expect((await inRussian())("playlist.retryFailed", { n })).toBe(expected)
  })

  test("and english leaves that one alone", async () => {
    expect((await inEnglish())("playlist.retryFailed", { n: 3 })).toBe(
      "Retry the 3 that failed"
    )
  })

  /**
   * the one sentence here that agreement would have got wrong: "все 1 видео"
   * at 1, and again at 21. naming the scope first and the count second makes
   * the phrase invariant, so every number reads the same way.
   */
  test.each([
    [1, "весь плейлист: 1 видео"],
    [2, "весь плейлист: 2 видео"],
    [5, "весь плейлист: 5 видео"],
    [11, "весь плейлист: 11 видео"],
    [21, "весь плейлист: 21 видео"],
    [100, "весь плейлист: 100 видео"]
  ])("the mixed link offers %i videos in russian", async (n, expected) => {
    expect((await inRussian())("mixedLink.playlistChoice", { n })).toBe(expected)
  })

  // the capped choice is a different sentence and keeps its own wording: a
  // hundred rows out of five thousand is not "the whole playlist"
  test("and says only the first hundred when that is all it holds", async () => {
    expect((await inRussian())("mixedLink.playlistFirst", { n: 100 })).toBe(
      "первые 100 видео"
    )
  })

  // the count in this one is not the number the sentence agrees on: the total
  // decides "video" or "videos", and the saves are just a number in front
  test.each([
    [{ saved: 1, n: 1 }, "1 of 1 video saved"],
    [{ saved: 8, n: 9 }, "8 of 9 videos saved"],
    [{ saved: 0, n: 21 }, "0 of 21 videos saved"]
  ])("the summary agrees with the total, not the saves", async (params, expected) => {
    expect((await inEnglish())("playlist.summarySaved", params)).toBe(expected)
  })

  test("and russian says it the other way round", async () => {
    expect((await inRussian())("playlist.summarySaved", { saved: 8, n: 9 })).toBe(
      "сохранено 8 из 9 видео"
    )
  })
})

/**
 * main keeps its english - it is what the logs, the analytics and the issue
 * bodies carry, and maintainers read those - so the translation is an overlay
 * applied at the one point the text becomes a toast. Which means the failure
 * mode that matters is a category or code this dictionary has not caught up
 * with: it must fall through to main's sentence rather than to a blank.
 */
describe("localizeError", () => {
  const blocked = {
    message: "YouTube asked us to confirm you're not a bot.",
    suggestion: "Import your YouTube cookies from Settings and try again.",
    category: "BOT_DETECTION"
  }

  test("leaves an english reader with main's own wording", async () => {
    const { localizeError } = await freshStore()

    expect(localizeError(blocked)).toBe(blocked)
  })

  test("swaps both sentences for a category it knows", async () => {
    const { localizeError, useLocale } = await freshStore()
    useLocale.getState().setLocale("ru")

    expect(localizeError(blocked)).toEqual({
      message: "YouTube просит подтвердить, что вы не бот.",
      suggestion: "импортируйте cookies YouTube в настройках и попробуйте снова.",
      category: "BOT_DETECTION"
    })
  })

  test.each([["SOMETHING_NEW"], [undefined]])(
    "hands back %s untouched",
    async (category) => {
      const { localizeError, useLocale } = await freshStore()
      useLocale.getState().setLocale("ru")

      const error = { message: "main said something new", category }

      expect(localizeError(error)).toBe(error)
    }
  )

  // ru.ts has an entry per key of ERROR_METADATA and TERMINAL_ERRORS, and a
  // category with only half a translation would show a russian message above an
  // english suggestion
  test("gives every russian entry both halves", async () => {
    const { ruErrors } = await import("./ru")

    expect(
      Object.entries(ruErrors).filter(
        ([, value]) => !value?.message.trim() || !value?.suggestion.trim()
      )
    ).toEqual([])
  })
})

// the same overlay for main's cookie sentences, which travel with a code rather
// than a taxonomy category
describe("localizeCode", () => {
  test("keeps main's sentence for an english reader", async () => {
    const { localizeCode } = await freshStore()

    expect(localizeCode("JAR_NOTHING_IMPORTED", "nothing imported yet")).toBe(
      "nothing imported yet"
    )
  })

  test("says the russian one when the code is known", async () => {
    const { localizeCode, useLocale } = await freshStore()
    useLocale.getState().setLocale("ru")

    expect(localizeCode("JAR_NOTHING_IMPORTED", "nothing imported yet")).toBe(
      "пока ничего не импортировано"
    )
  })

  test.each([["JAR_SOMETHING_NEW"], [null], [undefined]])(
    "falls back to main's english for %s",
    async (code) => {
      const { localizeCode, useLocale } = await freshStore()
      useLocale.getState().setLocale("ru")

      expect(localizeCode(code, "main said something new")).toBe(
        "main said something new"
      )
    }
  )
})
