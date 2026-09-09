import { create } from "zustand"

import { en, type Key } from "./en"
import { ru, ruCodes, ruErrors } from "./ru"

export type { Key }
export type Locale = "en" | "ru"

const STORAGE_KEY = "cliply-locale"

// the categories Intl.PluralRules can return for each language, in the order a
// dictionary value lists its forms
const PLURAL_FORMS: Record<Locale, string[]> = {
  en: ["one", "other"],
  ru: ["one", "few", "many"]
}

export const detectLocale = (language: string | undefined): Locale =>
  language?.toLowerCase().startsWith("ru") ? "ru" : "en"

/**
 * both guarded, because this module loads outside a browser too.
 *
 * feature-detected rather than `typeof window`: node defines a `localStorage`
 * global of its own that has none of the methods, and it shadows the one the
 * test environment installs. anything without `getItem` is not storage.
 */
const store = (): Storage | undefined => {
  const candidate = globalThis.localStorage

  return typeof candidate?.getItem === "function" ? candidate : undefined
}

const setHtmlLang = (locale: Locale) => {
  if (typeof document !== "undefined") document.documentElement.lang = locale
}

export const useLocale = create<{
  locale: Locale
  setLocale: (locale: Locale) => void
}>((set) => {
  const stored = store()?.getItem(STORAGE_KEY)
  const locale: Locale =
    stored === "en" || stored === "ru"
      ? stored
      : detectLocale(globalThis.navigator?.language)
  setHtmlLang(locale)

  return {
    locale,
    setLocale: (next) => {
      store()?.setItem(STORAGE_KEY, next)
      setHtmlLang(next)
      set({ locale: next })
    }
  }
})

/**
 * translate. reads the locale from the store rather than from react, so hooks
 * and plain modules like `toast-utils` can call it too.
 */
export function t(key: Key, params?: Record<string, string | number>): string {
  const locale = useLocale.getState().locale
  const dict: Record<string, string> = locale === "ru" ? ru : en
  let value = dict[key] ?? key

  if (value.includes("|")) {
    const forms = value.split("|")
    const category = new Intl.PluralRules(locale).select(Number(params?.n))
    // an unlisted category (russian `other`, for fractions) takes the last form
    value =
      forms[PLURAL_FORMS[locale].indexOf(category)] ?? forms[forms.length - 1]
  }

  return params
    ? value.replace(/\{(\w+)\}/g, (whole, name) => String(params[name] ?? whole))
    : value
}

/**
 * main's wording for a failure, in the reader's language
 *
 * main stays english - its sentences are what the logs, analytics and issue
 * bodies carry - so the swap happens here, at the one place the text becomes a
 * toast. an english reader, or a category `ruErrors` has no entry for, gets
 * exactly what main sent.
 */
export function localizeError<
  T extends { message: string; suggestion?: string; category?: string }
>(error: T): T {
  const russian =
    useLocale.getState().locale === "ru" && error.category
      ? ruErrors[error.category]
      : undefined

  return russian ? { ...error, ...russian } : error
}

/** the same swap for main's cookie sentences, which travel with a code */
export function localizeCode(
  code: string | null | undefined,
  english: string
): string {
  const russian =
    useLocale.getState().locale === "ru" && code ? ruCodes[code] : undefined

  return russian ?? english
}

/** `t`, plus a subscription so the component re-renders when the locale flips */
export function useT() {
  useLocale((s) => s.locale)
  return t
}
