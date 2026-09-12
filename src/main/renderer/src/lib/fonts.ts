/**
 * the monospace stack the app names inline, in one place
 *
 * Tailwind's `font-mono` resolves to `var(--font-mono)`, and that variable is
 * defined nowhere in `index.css`, so the declaration is invalid and the element
 * silently inherits its parent's family instead of a monospace one. Every
 * monospace run in the app therefore names the fonts itself (`HeroSection`,
 * `VideoLayout`, `URLInput`), and this is that stack, shared rather than copied
 * again for the downloads panel.
 *
 * Geist Mono is not bundled or fetched (only Space Grotesk is, in `index.html`),
 * so this lands on the platform's own monospace. That matters for ru: the
 * system monospace carries Cyrillic, so the panel's numbers and chips stay
 * monospace there while `font-space-grotesk` falls through to the system sans,
 * exactly as the playlist screen does.
 */
export const MONO =
  'Geist Mono, ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace'
