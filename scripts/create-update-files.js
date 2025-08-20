#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

// dist directory
const distDir = path.join(__dirname, '..', 'dist')

// current timestamp
const releaseDate = new Date().toISOString()

// check which platform was just built by looking at existing files
const distFiles = fs.readdirSync(distDir)
let builtPlatform = null

if (distFiles.some(file => file.includes('mac') || file.includes('arm64') || file.includes('.dmg'))) {
  builtPlatform = 'mac'
} else if (distFiles.some(file => file.includes('Setup') || file.includes('.exe'))) {
  builtPlatform = 'win'
} else if (distFiles.some(file => file.includes('AppImage') || file.includes('.deb'))) {
  builtPlatform = 'linux'
}

console.log(`detected build platform: ${builtPlatform}`)
console.log(`creating dummy update files for other platforms...`)

// dummy file template - use older version so clients know they're already up to date
const createDummyContent = () => `version: 0.0.1
files: []
path: null
sha512: null
releaseDate: '${releaseDate}'
`

// create dummy files for platforms that weren't built
const filesToCreate = []

if (builtPlatform !== 'win') {
  filesToCreate.push({ file: 'latest.yml', name: 'windows' })
}

if (builtPlatform !== 'mac') {
  filesToCreate.push({ file: 'latest-mac.yml', name: 'macos' })
}

if (builtPlatform !== 'linux') {
  filesToCreate.push({ file: 'latest-linux.yml', name: 'linux' })
}

// write dummy files
filesToCreate.forEach(({ file, name }) => {
  const filePath = path.join(distDir, file)
  
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, createDummyContent())
    console.log(`created dummy ${file} for ${name}`)
  } else {
    console.log(`${file} already exists, skipping`)
  }
})

console.log(`all platforms now have update metadata files`)
console.log(`clients will see "no update available" instead of 404 errors`)