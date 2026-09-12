/**
 * the monospace stack the app names inline, in one place
 *
 * `--font-mono` in `index.css` is this same list, which is what Tailwind's
 * `font-mono` resolves to: the class and this constant are the one stack said
 * twice, and they have to stay that way. This is for the call sites that set
 * the family inline rather than through a class (`HeroSection`, `VideoLayout`,
 * `URLInput` and the layouts), which is how they were all written before the
 * variable existed.
 *
 * Geist Mono is not bundled or fetched (only Space Grotesk is, in `index.html`),
 * so this lands on the platform's own monospace. That matters for ru: the
 * system monospace carries Cyrillic, so the panel's numbers and chips stay
 * monospace there while `font-space-grotesk` falls through to the system sans,
 * exactly as the playlist screen does.
 */
export const MONO =
  'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
