const { ownedPartialBytes } = require("../scripts/local-smoke-sampling")
const fail = code => { throw Object.assign(new Error(code), { code }) }

test.each(["root", "directory", "file"])("owned partial disappearance during %s sampling is harmless", step => {
  const io = {
    readdirSync: jest.fn(file => file === "/fixture"
      ? step === "root" ? fail("ENOENT") : ["finished.mp4", ".cliply-export-owned"]
      : step === "directory" ? fail("ENOENT") : ["partial"]),
    statSync: jest.fn(() => step === "file" ? fail("ENOENT") : { size: 123 })
  }
  expect(ownedPartialBytes("/fixture", io)).toBe(0)
})
test("only task-owned partials are counted and other errors remain visible", () => {
  const io = { readdirSync: file => file === "/fixture" ? ["output.mp4", ".cliply-export-owned"] : ["partial", "marker"], statSync: () => ({ size: 7 }) }
  expect(ownedPartialBytes("/fixture", io)).toBe(14)
  io.statSync = () => fail("EACCES")
  expect(() => ownedPartialBytes("/fixture", io)).toThrow("EACCES")
})
