const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path")
const CookieManager = require("../src/main/services/cookie-manager")
test("concurrent startup calls share cookie initialization and allow later refresh", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-cookie-init-"))
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const manager = Object.assign(Object.create(CookieManager.prototype), {
    cookieDir: directory, ensureCookieFile: jest.fn(() => barrier), validateCookieFile: jest.fn(async () => false)
  })
  let runs = []
  try {
    const first = manager.initialize(), second = manager.initialize()
    runs = [first, second]
    expect(first).toBe(second)
    release(); await Promise.all([first, second])
    expect(manager.ensureCookieFile).toHaveBeenCalledTimes(1)
    await manager.initialize()
    expect(manager.ensureCookieFile).toHaveBeenCalledTimes(2)
  } finally { release(); await Promise.allSettled(runs); await fs.rm(directory, { recursive: true, force: true }) }
})
