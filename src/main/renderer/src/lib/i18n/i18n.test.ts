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
