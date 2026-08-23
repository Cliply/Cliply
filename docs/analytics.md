# analytics — notes for whoever reads the charts

[`PRIVACY.md`](../PRIVACY.md) is the user-facing document and says what leaves the
machine. this one is for the person looking at a dashboard, and it is about how to
read what arrives. everything here is a property of how the data is *produced*, so
none of it is visible from inside posthog.

the authority for what exists is [`src/main/services/analytics.js`](../src/main/services/analytics.js):
`ALLOWED_PROPERTIES` is the exhaustive event and property list, `PROPERTY_KINDS`
and `PROPERTY_VOCABULARIES` say what values are permitted, and
[`tests/analytics-pii-guard.test.js`](../tests/analytics-pii-guard.test.js) pins the
shape of the boundary. this file does not repeat those lists, because a second copy
would be the one that goes stale.

## metrics that will mislead you if you take them at face value

### `elapsed_bucket` on `download_completed` is not engine throughput

the clock starts in `DownloadRunner.reserve()` (`src/main/services/download-runner.js`),
which runs when the renderer asks for the download, and stops when the finished file
settles. that span includes waiting on the engine gate, creating the handle, an
engine repair-and-retry if one happened, and ffmpeg's merge or trim pass.

it is the right number for "how long did this feel to the person", which is what it
is for. it is the wrong number for "how fast is yt-dlp".

### `speed_bucket` understates whenever a repair ran

`speedBucket(fileSize, elapsedMs)` divides the finished file's size by that same
wall clock. a download that failed on a stale engine, triggered a repair, and
succeeded on the second attempt divides the bytes of *one* download by the elapsed
time of two attempts plus an engine update. the bucket that comes out is real but it
is not a measurement of the connection.

there is no flag on the event saying a repair happened, so a low `speed_bucket`
cannot be told from a repaired one after the fact. read the distribution's shape
rather than its tail.

### `engine_update_failed` is not a failure count

`update_reason` includes `busy`, which means the update check refused to run at all
because a download held the engine gate — nothing failed, the check was skipped. it
is on the event on purpose: an install whose engine therefore never updates is
exactly what this event exists to find. but it is a different thing from
`checksum-mismatch` or `download-failed`.

**always split this metric by `update_reason`.** the raw event count answers no
question anybody has.

`check-rejected` is also worth separating: it means `checkForUpdate()` threw rather
than returned, which points at a bug in our own code, while `check-failed` is the
ordinary network blip of a tag lookup that failed and returned normally. they are
deliberately not merged.

### `error_message` is lossy in a way that is not uniform

the sanitizer's scrub-then-refuse design (see the long comment above `TEXT_PLACEHOLDER`
in `analytics.js`) means some messages arrive whole, some arrive with `[path]` or
`[file]` markers in them, and some arrive as the literal `[redacted]`. the split is
not random — it depends on what shapes the message happened to contain — so
`[redacted]` counting high for one `error_category` says something about that error's
wording, not about how often it happens.

there is one known over-catch: the credential rule matches a marker word anywhere in
a key being assigned a value, so `cookies: 3` becomes `[credential]`. that is a
data-quality cost, taken deliberately in the fail-closed direction, and it is
asserted in the pii guard so it stays visible. don't try to read cookie counts out of
error text.

## declared but never sent

two properties are on the allow-list and no caller populates them. they are not
broken; nothing produces a value for them yet.

| property | event | why it's empty |
| --- | --- | --- |
| `load_ms_bucket` | `media_info_loaded` | the renderer sends `duration_bucket` and `formats_count` and does not time the lookup |
| `elapsed_bucket` | `engine_seeded` | `index.js` sends `reason` and `engine_version` only |

if a chart on either of these is flat, that is why. removing them from
`ALLOWED_PROPERTIES` is also fine — the allow-list is a permission, not a promise.

## the funnel, and where it can lie

`app_launched` → `url_submitted` → `media_info_loaded` → `download_started` →
`download_completed`.

- `url_submitted` fires before the lookup, so `media_info_loaded` + `media_info_failed`
  should roughly account for it. a shortfall is a lookup that was still running when
  the app quit.
- `download_started` is raised by the renderer, `download_completed` / `_failed` /
  `_cancelled` by the main process through the runner. a quit mid-download produces a
  `download_started` with no terminal event — the app flushes at quit, but only for
  events that were already captured.
- `platform` is normalized rather than dropped: an unrecognised site arrives as
  `unsupported`, so the event still counts rather than vanishing. read that bucket as
  *how often* people try a site we do not support — it cannot tell you *which* sites
  those are. every unrecognised value becomes the same literal and no hostname is kept
  anywhere, so there is nothing behind the count to break down. answering "which sites"
  would take a deliberate change: adding the site to `KNOWN_PLATFORMS` in
  [`analytics.js`](../src/main/services/analytics.js), by name, one at a time.

## which builds send anything

`Analytics` only initializes when `app.isPackaged` is true — an installed build —
or `CLIPLY_ANALYTICS_DEV === "1"`. a plain `npm run dev` sends nothing, which is why
the dev-mode check needs the env var:

```bash
CLIPLY_ANALYTICS_DEV=1 npm run dev
```

every event carries `environment`, which is `production` in a packaged build and
`development` in a dev opt-in session. **filter on it.** dev sessions are otherwise
indistinguishable from real ones, and — more to the point — a dashboard receiving
nothing from `production` is the shape a broken gate has.

that is not hypothetical. this gate previously read `NODE_ENV === "production"`, and
nothing sets `NODE_ENV` in a packaged app: not the dev scripts (they set
`development`), not electron-builder, and there is no `.env`. every installed build
evaluated it to false and sent zero events. `app.isPackaged` is electron's own answer
and is true in exactly the builds this is about; `NODE_ENV` is deliberately not kept
as a second signal, because tooling sets it for reasons of its own and a developer
machine carrying `NODE_ENV=production` would report into the production project.

the lookup fails closed: if `require("electron")` cannot be read, the build is
treated as unpackaged and sends nothing. that costs a real packaged build nothing —
there, electron is part of the runtime — and the only place it can fail is outside
electron, where sending would be wrong.

on top of that, `APP_CONFIG.ANALYTICS_CONFIG.ENABLED` in
[`src/main/utils/constants.js`](../src/main/utils/constants.js) is a build-time kill
switch, and the user's own preference is read once at `init()`.

## the two SDK options that are set against their defaults

Both exist because `posthog-node` is written for a server and this is a desktop
client, and both are the kind of line a later reader deletes as redundant.

| option | default | why ours differs |
| --- | --- | --- |
| `disableGeoip: false` | `true` (the JSDoc says `false`; the compiled source reads `?? true`) | without it, posthog never resolves country/region/city — silently |
| `isServer: false` | `true` | without it, `$is_server: true` rides every event and labels the whole project server-side |

Each is pinned twice in `tests/analytics.test.js`: once on the options the real
factory passes, and once on the *SDK's own* behaviour without the option, so
deleting either line fails loudly instead of quietly changing what ships.

`isServer: false` **omits** the property rather than sending `false` —
`getCommonEventProperties()` only sets it when the option is truthy. That is what
`PRIVACY.md`'s list of what PostHog adds depends on, and a third test pins the whole
of that common-property set (`$lib`, `$lib_version`, nothing else) so a version bump
that starts attaching a fourth property makes the document's claim fail rather than
quietly become false.

## two things this repo cannot tell you

both are settings on the posthog project rather than anything in the code. no test can
reach either, so nothing here will go red if one of them changes.

- **whether the raw client ip is discarded.** the app sets `disableGeoip: false`, which
  is what makes posthog resolve country/region/city, and it never sends an address as a
  property of its own — both of those are code facts. whether `$ip` is *retained*
  alongside the derived location is the project's **"discard client IP data"** setting,
  and nothing in this repo establishes it either way.

  `PRIVACY.md` states that the address is discarded. **That sentence is the one claim in
  the user-facing document with nothing in the codebase behind it.** If the toggle is
  ever turned off, `PRIVACY.md` becomes false and no build will notice — so if you touch
  that project setting, go and change the document too.
- **retention.** nothing in the app configures one, and `PRIVACY.md` deliberately states
  no number: it says only that retention is a setting on the posthog project. That is a
  decision, not an omission waiting to be filled in — an invented figure in a privacy
  policy is worse than an honest "this is configured elsewhere". If it is ever stated,
  it has to be checked against the project first.

## a framing note, since it is easy to lose

`PRIVACY.md` calls the data **pseudonymous, not anonymous**, and says so in those words.
Every event carries a persistent install UUID plus a derived city, and that id survives
updates *and* reinstalls because it lives in `~/.config/app-data-7c4f/settings.json`,
outside the bundle. Deleting the file rotates future identity; it cannot unlink events
already sent.

So the document promises what we *do* — we don't sell it, posthog is the only processor
— rather than asserting that linking is impossible, which the system does not support.
Anything added here later should hold the same line: a commitment about our conduct is
fine, a claim that something is technically impossible needs the code behind it.
