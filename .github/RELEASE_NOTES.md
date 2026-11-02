### Linux x64

Linux downloads are available as an AppImage and a `.deb`. FFmpeg, Deno and yt-dlp are bundled; no separate runtime installation is needed.

For the AppImage, allow execution in your file manager, or run `chmod +x Cliply-*-x64.AppImage`, then open it. For Ubuntu/Debian, install the `.deb` through your software installer or `sudo apt install ./Cliply-*-x64.deb` so system dependencies are resolved.

Builds are checked on Ubuntu 24.04 x64. Other distributions and desktop environments may behave differently. Linux ARM builds are not included.

### macOS

When opening Cliply for the first time, you might see a security warning because macOS Gatekeeper blocks unsigned apps by default. This is because we haven't added code signing yet. It requires a paid certificate, and as a small project, we're prioritizing what matters most first.

To open the app, you can safely run this command in Terminal to remove the security restriction:

```bash
sudo xattr -rd com.apple.quarantine /Applications/Cliply.app
```

**What this does:** It removes the "downloaded from the internet" flag from Cliply, telling macOS that you trust the app.

**Safety tips:**

* Only run this command on apps from trusted sources, like the official GitHub release.
* Optionally, scan the downloaded file with VirusTotal or similar tools.

For a **detailed, step-by-step explanation of this command and why it's safe**, see this guide: [Google Gemini](https://g.co/gemini/share/14f63c8b12b6)
