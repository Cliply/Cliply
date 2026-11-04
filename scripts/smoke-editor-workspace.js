// Real Chromium geometry/keyboard checks for the resizable editor. Called by
// the existing synthetic trim smoke; no user profile or media is involved.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

// Change the shared preferences through their only product entry point.
async function setPreferences({ window, locale, dark }) {
  const js = code => window.webContents.executeJavaScript(code)
  const click = label => js(`Array.from(document.querySelectorAll('button,a')).find(e => (e.getAttribute('aria-label') || e.textContent.trim()) === ${JSON.stringify(label)}).click()`)
  const wait = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await js(expression)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Workspace condition timed out: ${expression}`)
  }
  await js("document.querySelector('.editor-back')?.click()")
  await wait("!!document.querySelector('a[href=\"#/media\"]')")
  await click(locale)
  if (dark !== undefined && await js("document.documentElement.classList.contains('dark')") !== dark) await click(locale === "ru" ? "переключить тему" : "Toggle theme")
  await js("document.querySelector('a[href=\"#/media\"]').click()")
  await wait("!!document.querySelector('.media-workspace')")
  await js("document.fonts.ready.then(() => true)")
}

async function run({ window }) {
  const wc = window.webContents
  const js = code => wc.executeJavaScript(code)
  const settle = async () => {
    await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  const preferences = async (locale, dark) => {
    await setPreferences({ window, locale, dark })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await js("document.querySelector('video')?.readyState >= 2")) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error("Preview did not reload after returning from preferences")
  }
  const bounds = window.getBounds()
  const minimumSize = window.getMinimumSize()
  const facts = []
  const initialTheme = await js("document.documentElement.classList.contains('dark')")
  let failure
  try {
    // The fixed content-size case reproduces Windows' smaller client area on
    // every host, independently of native frame/menu sizes and display scaling.
    for (const [width, height, locale, contentSize] of [[1200, 800, "en", false], [800, 600, "en", false], [800, 600, "ru", false], [784, 535, "ru", true]]) {
      if (contentSize) { window.setMinimumSize(0, 0); window.setContentSize(width, height) }
      else window.setSize(width, height)
      await preferences(locale, locale === "ru")
      await settle()
      const geometry = await js(`(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON()
        const trim = document.getElementById('trim-panel')
        const lane = box('[data-testid=cut-timeline]')
        return {
          viewport: [innerWidth, innerHeight],
          page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
          inspector: box('.editor-inspector'), preview: box('.media-preview-stage'),
          lane, footer: trim.children[2].getBoundingClientRect().toJSON(), timelinePane: box('.editor-timeline-pane'),
          inspectorOverflow: document.querySelector('.editor-inspector').scrollWidth > document.querySelector('.editor-inspector').clientWidth,
          mediaReady: document.querySelector('video').readyState >= 2,
          playhead: document.querySelector('video').currentTime,
          font: getComputedStyle(document.querySelector('.media-workspace')).fontFamily,
          appFont: getComputedStyle(document.body).fontFamily,
          primary: getComputedStyle(document.querySelector('.media-workspace')).getPropertyValue('--primary'),
          appPrimary: getComputedStyle(document.documentElement).getPropertyValue('--primary'),
          duplicatePreferences: Array.from(document.querySelectorAll('.editor-header button')).some(e => /^(en|ru|Toggle theme|переключить тему)$/.test(e.getAttribute('aria-label') || e.textContent.trim()))
        }
      })()`)
      facts.push({ width, height, locale, contentSize, geometry })
      // Keep the failing geometry too, not only screenshots of earlier cases.
      if (process.env.CLIPLY_SMOKE_EVIDENCE) {
        fs.mkdirSync(process.env.CLIPLY_SMOKE_EVIDENCE, { recursive: true })
        fs.writeFileSync(path.join(process.env.CLIPLY_SMOKE_EVIDENCE, "workspace-layout.json"), JSON.stringify({ facts }, null, 2))
        fs.writeFileSync(path.join(process.env.CLIPLY_SMOKE_EVIDENCE, `workspace-${width}-${locale}.png`), (await wc.capturePage()).toPNG())
      }
      assert(geometry.page[0] <= geometry.viewport[0] + 1, "workspace does not overflow the window horizontally")
      assert(geometry.page[1] <= geometry.viewport[1] + 1, "workspace stays inside the window vertically")
      assert(geometry.inspector.width >= 258, "inspector retains its readable minimum width")
      assert(geometry.preview.width >= 320 && geometry.preview.height >= 100, "preview remains visible at the minimum window size")
      assert(geometry.lane.bottom <= geometry.footer.top + 1, "timeline and transport footer do not overlap")
      assert(geometry.footer.bottom <= geometry.timelinePane.bottom + 1, "transport footer remains visible without scrolling at the default layout")
      assert(!geometry.inspectorOverflow, "inspector controls fit in both locales")
      assert(geometry.mediaReady, "layout changes preserve decoded playback")
      assert(geometry.font.includes("Space Grotesk") && geometry.appFont.includes("Space Grotesk"), "editor uses the app's shared font")
      assert.equal(geometry.primary, geometry.appPrimary, "editor inherits the shared theme tokens")
      assert(!geometry.duplicatePreferences, "editor does not duplicate home preferences")
    }
    await preferences("en", initialTheme)
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
  } catch (error) {
    failure = error
  } finally {
    try {
      await preferences("en", initialTheme)
    } catch (error) {
      failure ||= error
    } finally {
      window.setBounds(bounds)
      window.setMinimumSize(...minimumSize)
      await settle()
    }
  }
  if (failure) throw failure
  console.log("Editor workspace: 1200x800 / 800x600 windows and 784x535 client area, EN/RU, light/dark, keyboard resizing without seeking passed")
}

module.exports = { run, setPreferences }
