# Russian localization — Design

Date: 2026-09-08
Status: Approved

## Why

About 80% of active installs run with a Russian system locale (PostHog, `app_launched`
by `locale`, Aug–Sep 2026). The UI is English only. The goal is a Russian user can use the
main flows (paste a link, download, import cookies when YouTube blocks them) without a
dictionary. Nothing about the layout, colours, fonts or motion changes.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Mechanism | Two typed dictionary files, no library | ~150 strings, two languages. `tsc` fails on a missing translation, which JSON in react-i18next cannot do. No new dependency. |
| Detection | `navigator.language` starts with `ru` → Russian, else English | Electron sets it from the same value as `app.getLocale()`. No IPC. |
| Override | A `ru / en` text toggle beside the theme toggle, persisted in `localStorage` | An explicit choice beats the system locale. Rescues `uk` / `en-GB` users who read Russian. |
| Fonts | Unchanged | Geist Mono was never loaded, so the OS mono fallback (has Cyrillic) is what everyone already sees. Space Grotesk has no Cyrillic; Cyrillic falls through to `system-ui`. Accepted for v1. |
| Main-process error wording | Stays English in main; renderer localizes by error `code` | Main's text still feeds logs, analytics and GitHub issue bodies, which maintainers read in English. |
| Native app menu | Localized in main from `app.getLocale()` | Small label table. Follows the OS, not the in-app toggle. |
| About page | Stays English in v1 | Long prose, low traffic, not a main flow. |

## Shape

```
src/main/renderer/src/lib/i18n/
  en.ts      flat object: { "hero.tagline": "download stuff effortlessly", ... } as const
  ru.ts      Record<keyof typeof en, string>  plus ruErrors: partial map of error code → {message, suggestion}
  index.ts   useLocale store (zustand), t(key, params?), useT(), detectLocale(), localizeError()
```

- `t("cookies.count", { n })` interpolates `{n}`. A value containing `|` is a plural set
  (`en`: `one|other`, `ru`: `one|few|many`) chosen with `Intl.PluralRules(locale).select(n)`.
- `useLocale` initial state: `localStorage["cliply-locale"]` if `"en"` or `"ru"`, else
  `detectLocale(navigator.language)`. Setting it writes `localStorage` and `<html lang>`.
- `localizeError({ code, message, suggestion })` returns `ruErrors[code]` when the locale is
  `ru` and the code is known, otherwise the object it was given. Same idea for the cookie
  manager's `problem` and `note` sentences, which get a stable `code` alongside the text.
- Product names stay Latin: YouTube, TikTok, Pinterest, cookies.txt, yt-dlp, Chrome, Firefox.
- Voice: lowercase, plain, short, matching the English. No em-dashes in UI copy.

## Surfaces

In: hero (tagline, cookie hint, menu, footer), URL input and per-platform helper text,
validation messages, cookie dialog (steps, notes, status, buttons, toasts, main's problem
sentences), download card (tabs, labels, dropdowns, time range, buttons), progress bar,
every toast in `toast-utils` and the download hooks, main's error wording, update
notification, report dialog UI (not the issue body), support dialog, native app menu.

Out: about page, `PRIVACY.md`, GitHub issue body, analytics property values.

## Testing

- Existing renderer tests keep asserting English; jsdom reports `en-US`.
- `i18n.test.ts`: `ru` has every `en` key and no extras; interpolation; plural selection for
  `ru` (1, 2, 5, 21) and `en`; `detectLocale` for `ru-RU`, `ru`, `en-GB`, `uk`; stored
  override wins.
- Russian renders of `CookieDialog` and the bot-detection toast, since those are the
  surfaces the request is about.
- Manual: run the app, flip the toggle, walk the three flows.
