#!/usr/bin/env node

// checks if all required icon files exist

const fs = require("fs")
const path = require("path")

const requiredIcons = [
  "icon.icns", // macOS
  "icon.ico", // Windows
  "icon.png", // Linux/General
  "icon-16x16.png",
  "icon-24x24.png",
  "icon-32x32.png",
  "icon-48x48.png",
  "icon-64x64.png",
  "icon-96x96.png",
  "icon-128x128.png",
  "icon-256x256.png",
  "icon-512x512.png"
]

const assetsDir = path.join(__dirname, "..", "assets")

console.log("checking icon files...")

let allIconsExist = true

for (const iconFile of requiredIcons) {
  const iconPath = path.join(assetsDir, iconFile)

  if (fs.existsSync(iconPath)) {
    console.log(`found: ${iconFile}`)
  } else {
    console.error(`missing: ${iconFile}`)
    allIconsExist = false
  }
}

if (allIconsExist) {
  console.log("all required icons are present")
  process.exit(0)
} else {
  console.error(
    "some icons are missing. please generate them before building."
  )
  process.exit(1)
}
