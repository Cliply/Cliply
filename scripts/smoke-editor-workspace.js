// Real Chromium geometry/keyboard checks for the resizable editor. Called by
// the existing synthetic trim smoke; no user profile or media is involved.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

async function run({ window }) {
  const wc = window.webContents
  const js = code => wc.executeJavaScript(code)
  const settle = async () => {
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  const click = label => js(`Array.from(document.querySelectorAll('button,a')).find(e => (e.getAttribute('aria-label') || e.textContent.trim()) === ${JSON.stringify(label)}).click()`)
  const bounds = window.getBounds()
  const facts = []
  const initialTheme = await js("document.documentElement.classList.contains('dark')")
  try {
    for (const [width, height, locale] of [[1200, 800, "en"], [800, 600, "en"], [800, 600, "ru"]]) {
      window.setSize(width, height)
      await click(locale)
      if (locale === "ru" && !initialTheme) await click("переключить тему")
      await settle()
      const geometry = await js(`(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON()
        const trim = document.getElementById('trim-panel')
        const lane = box('[data-testid=cut-timeline]')
        return {
          viewport: [innerWidth, innerHeight],
          page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
          inspector: box('.editor-inspector'), preview: box('.media-preview-stage'),
          lane, footer: trim.children[2].getBoundingClientRect().toJSON(),
          inspectorOverflow: document.querySelector('.editor-inspector').scrollWidth > document.querySelector('.editor-inspector').clientWidth,
          mediaReady: document.querySelector('video').readyState >= 2,
          playhead: document.querySelector('video').currentTime
        }
      })()`)
      assert(geometry.page[0] <= geometry.viewport[0] + 1, "workspace does not overflow the window horizontally")
      assert(geometry.page[1] <= geometry.viewport[1] + 1, "workspace stays inside the window vertically")
      assert(geometry.inspector.width >= 258, "inspector retains its readable minimum width")
      assert(geometry.preview.width >= 320 && geometry.preview.height >= 100, "preview remains visible at the minimum window size")
      assert(geometry.lane.bottom <= geometry.footer.top + 1, "timeline and transport footer do not overlap")
      assert(!geometry.inspectorOverflow, "inspector controls fit in both locales")
      assert(geometry.mediaReady, "layout changes preserve decoded playback")
      facts.push({ width, height, locale, geometry })
      if (process.env.CLIPLY_SMOKE_EVIDENCE) {
        fs.mkdirSync(process.env.CLIPLY_SMOKE_EVIDENCE, { recursive: true })
        fs.writeFileSync(path.join(process.env.CLIPLY_SMOKE_EVIDENCE, `workspace-${width}-${locale}.png`), (await wc.capturePage()).toPNG())
      }
    }
    await click("en")
    window.setSize(1200, 800)
    await settle()
    const before = await js(`(() => {
      document.querySelector('[aria-label="Resize inspector"]').focus()
      return { width: document.querySelector('.editor-inspector').getBoundingClientRect().width, time: document.querySelector('video').currentTime }
    })()`)
    wc.sendInputEvent({ type: "keyDown", keyCode: "Left" })
    wc.sendInputEvent({ type: "keyUp", keyCode: "Left" })
    await settle()
    const after = await js("({ width: document.querySelector('.editor-inspector').getBoundingClientRect().width, time: document.querySelector('video').currentTime })")
    assert(after.width > before.width, "keyboard separator resizing changes panel geometry")
    assert.equal(after.time, before.time, "separator arrows never seek the source")
    // Return the separator to its original position, then release keyboard focus.
    wc.sendInputEvent({ type: "keyDown", keyCode: "Right" })
    wc.sendInputEvent({ type: "keyUp", keyCode: "Right" })
    await js("document.activeElement.blur()")
    if (process.env.CLIPLY_SMOKE_EVIDENCE) fs.writeFileSync(path.join(process.env.CLIPLY_SMOKE_EVIDENCE, "workspace-layout.json"), JSON.stringify({ facts, keyboardResize: { before, after } }, null, 2))
    console.log("Editor workspace: 1200x800 and 800x600 geometry, EN/RU, light/dark, keyboard resizing without seeking passed")
  } finally {
    await click("en")
    if (await js("document.documentElement.classList.contains('dark')") !== initialTheme) await click("Toggle theme")
    window.setBounds(bounds)
    await settle()
  }
}

module.exports = { run }
