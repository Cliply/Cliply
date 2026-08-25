# third-party notices

cliply is built out of other people's work. this file lists what a cliply
install actually contains that somebody else wrote, and under what license.

cliply itself is **GPL-3.0-or-later** — see [`LICENSE`](LICENSE). it is GPL
because of the first entry below, and that entry is also the only one with an
obligation beyond attribution.

---

## bundled binaries

these are shipped inside the installer. they are not npm packages and they are
not in git — the build fetches them.

### FFmpeg — GPL-3.0-or-later

- **used for:** merging video and audio streams, trimming, audio conversion,
  subtitle conversion
- **license:** GPLv3 or later. the bundled builds are configured with
  `--enable-gpl --enable-version3`, which is what moves them from LGPL to GPL
- **license text:** [`third-party/ffmpeg/COPYING.GPLv3`](third-party/ffmpeg/COPYING.GPLv3),
  and ffmpeg's own summary in [`third-party/ffmpeg/LICENSE.md`](third-party/ffmpeg/LICENSE.md)
- **complete corresponding source:** [`third-party/ffmpeg/FFmpeg-d9797544b45a6f2fbd334dd41194b95026555297.zip`](third-party/ffmpeg/),
  the full tree at the commit the binaries were built from
- **build configuration:** [`third-party/ffmpeg/build-info.md`](third-party/ffmpeg/build-info.md)
- **the long version:** [`docs/ffmpeg.md`](docs/ffmpeg.md)
- **upstream:** <https://ffmpeg.org> · <https://github.com/FFmpeg/FFmpeg>

> [!IMPORTANT]
> this is the entry that makes cliply GPL. if you fork cliply and ship your own
> installers, the source obligation travels with the binary *you* ship — see
> [`docs/ffmpeg.md`](docs/ffmpeg.md#the-license).

### yt-dlp — Unlicense (public domain)

- **used for:** every download. cliply is a user interface around it
- **license:** [The Unlicense](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE)
- **how it gets here:** [`scripts/fetch-ytdlp.js`](scripts/fetch-ytdlp.js) downloads
  the official release build for the target platform and verifies its checksum,
  and the app keeps it up to date on its own afterwards
- **upstream:** <https://github.com/yt-dlp/yt-dlp>

cliply is **not affiliated with yt-dlp or youtube-dl**.

### Deno — MIT

- **used for:** the javascript runtime yt-dlp needs for youtube's challenges
  (required since yt-dlp 2025.11.12)
- **license:** [MIT](https://github.com/denoland/deno/blob/main/LICENSE.md)
- **upstream:** <https://github.com/denoland/deno>

### Electron — MIT

- **used for:** the application shell — window, menus, ipc, packaging
- **license:** [MIT](https://github.com/electron/electron/blob/main/LICENSE),
  and it carries Chromium (BSD-3-Clause and others) and Node.js (MIT) with it.
  the full component list for the shipped version is in
  `LICENSES.chromium.html`, next to the executable in every installed copy
- **upstream:** <https://github.com/electron/electron>

---

## bundled javascript

everything under `dependencies` ends up inside the app. the versions below are
the ones the lockfiles pin.

### main process

| package | version | license |
| --- | --- | --- |
| dotenv | 16.5.0 | BSD-2-Clause |
| electron-updater | 6.6.2 | MIT |
| posthog-node | 5.50.0 | MIT |
| uuid | 9.0.1 | MIT |

### renderer

| package | version | license |
| --- | --- | --- |
| @hookform/resolvers | 5.1.1 | MIT |
| @radix-ui/react-dialog | 1.1.14 | MIT |
| @radix-ui/react-progress | 1.1.7 | MIT |
| @radix-ui/react-slot | 1.2.3 | MIT |
| @radix-ui/react-tabs | 1.1.12 | MIT |
| @radix-ui/react-tooltip | 1.2.7 | MIT |
| @tanstack/react-query | 5.80.6 | MIT |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| clsx | 2.1.1 | MIT |
| framer-motion | 12.23.12 | MIT |
| lucide-react | 0.525.0 | ISC |
| next-themes | 0.4.6 | MIT |
| react | 19.1.0 | MIT |
| react-dom | 19.1.0 | MIT |
| react-hook-form | 7.57.0 | MIT |
| react-router-dom | 7.6.2 | MIT |
| sonner | 2.0.5 | MIT |
| tailwind-merge | 3.3.0 | MIT |
| tailwindcss-animate | 1.0.7 | MIT |
| zod | 3.25.57 | MIT |
| zustand | 5.0.5 | MIT |

build-time tools (electron-builder, vite, typescript, tailwind, eslint, jest,
vitest and their trees) are not shipped and are not listed here. they are all
MIT/ISC/Apache-2.0.

### regenerating the two tables

they are read straight off the lockfiles, so they can be checked rather than
trusted:

```bash
# the shipped dependency trees, with the versions the lockfiles pin
npm ls --omit=dev --all
(cd src/main/renderer && npm ls --omit=dev --all)

# and the licenses in those trees, enumerated
npx license-checker --production --summary
(cd src/main/renderer && npx license-checker --production --summary)
```

if you add a runtime dependency, add it here. a dependency with a license that
is not MIT / ISC / BSD / Apache-2.0 needs a second look before it lands: cliply
is GPLv3, so a dependency has to be GPL-compatible.

---

## assets

the icons and the artwork under [`assets/`](assets/) are cliply's own and are
covered by the repository license.
