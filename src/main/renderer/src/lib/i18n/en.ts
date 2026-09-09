/**
 * every string the ui says, in english
 *
 * english is the source of truth: `ru.ts` is typed against this object, so a
 * key added here without a translation is a compile error rather than a blank
 * label someone notices in production.
 *
 * `{name}` is substituted from `t`'s params. a value containing `|` is a plural
 * set, its forms in the order `Intl.PluralRules` lists for the language -
 * english `one|other`, russian `one|few|many`.
 */
export const en = {
  "hero.tagline": "download stuff effortlessly",
  "hero.cookieHint": "having trouble with downloads? try cookies",
  "hero.footerFree":
    "cliply is free and open source. just one guy tries to keep it running.",
  "hero.footerUseful": "if it's useful,",
  "hero.donate": "buy me a coffee",
  "hero.updateCheckFailed": "Check Failed",
  "hero.updateCheckFailedBody": "Failed to check for updates",

  "menu.about": "about",
  "menu.update": "update",
  "menu.donate": "donate",
  "menu.github": "github",

  "url.placeholder": "paste video url here...",
  // the details screen asks for a replacement link
  "url.replacePlaceholder": "Enter new video URL...",
  "url.loading": "\u{1F40B} getting video information",
  "url.loaded": "Video information loaded successfully!",
  "url.selectFolder": "Select folder",
  "url.pickerBusy": "Wait for the current link to finish",
  // the box takes a playlist link now, and a helper line that only mentions
  // videos and shorts is the reason somebody would never try one
  "url.youtubeHelper":
    "supports youtube videos, shorts & playlists from youtube.com and youtu.be",
  "url.pinterestHelper":
    "supports pin.it and pinterest.com/pin links, any country domain",
  "url.tiktokHelper":
    "supports tiktok.com/@user/video/ID, vm.tiktok.com, and vt.tiktok.com links",

  // the two toasts a playlist link sends from the search box
  "playlist.loaded": "Playlist loaded successfully!",
  "playlist.infoFailed": "Failed to get playlist information",

  "error.imageNotVideo": "This is an image, not a video",
  "error.imageNotVideoDesc": "Only videos can be downloaded",
  "error.youtubeUrl": "Invalid YouTube URL",
  "error.pinterestUrl": "Invalid Pinterest URL",
  "error.tiktokUrl": "Invalid TikTok URL",
  "error.unavailable": "This video is not available for download",
  "error.infoFailed": "Failed to get video information",
  "error.tiktokBlocked":
    "TikTok blocked this request. Please try again in a moment",

  "validation.youtubeRequired": "Please enter a YouTube URL",
  "validation.youtubeInvalid": "Please enter a valid YouTube URL",
  "validation.pinterestRequired": "Please enter a Pinterest URL",
  "validation.pinterestInvalid": "Please enter a valid Pinterest URL",
  "validation.tiktokRequired": "Please enter a TikTok URL",
  "validation.tiktokInvalid": "Please enter a valid TikTok URL",

  "theme.toggle": "Toggle theme",

  "folder.updated": "Download folder updated!",
  "folder.updateFailed": "failed to update download folder",

  "cookies.count": "{n} cookie|{n} cookies",
  "cookies.title": "youtube cookies",
  "cookies.description":
    "youtube sometimes decides this machine looks like a bot, usually because of your network rather than anything you did. a cookie file from your own browser is how you tell it otherwise.",
  "cookies.privacy":
    "you sign in to youtube in your own browser, never to cliply. everything stays on this device, we never upload any of it, and you can delete it whenever you want.",
  "cookies.ytdlpCredit": "it's the standard process yt-dlp recommends.",
  "cookies.readGuide": "read their guide",
  "cookies.signedIn": "signed in",
  "cookies.howTo": "here's how to import them",
  // split so the count can sit between the halves, as it does in english
  "cookies.stillHere": "your file is still here",
  "cookies.stillHereRest":
    ", it just stopped working. nothing got deleted. grab a fresh export and import it over the top.",
  "cookies.importedToday": "imported today",
  "cookies.importedYesterday": "imported yesterday",
  "cookies.importedDaysAgo": "imported {n} day ago|imported {n} days ago",

  "cookies.step1": "install",
  "cookies.step1or": "(chrome) or",
  "cookies.step1firefox": "(firefox)",
  "cookies.step2": "open youtube in your browser and sign in",
  "cookies.step2note":
    "use a spare account if you have one. youtube has been known to ban accounts it catches using downloaders.",
  "cookies.step3": "in that same tab, go to",
  "cookies.step3note":
    "parks the tab somewhere youtube isn't handing out fresh cookies.",
  "cookies.copyHint": "click to copy",
  "cookies.copied": "copied, paste it there",
  "cookies.step4": "click the extension's icon, then hit",
  // the extension's own button, which it labels in english whatever the browser
  "cookies.step4export": "export",
  "cookies.step4note":
    "up by your address bar, sometimes under the puzzle piece. saves a .txt to your downloads.",
  "cookies.step5": "close that youtube tab",
  "cookies.step5note":
    "youtube keeps refreshing cookies on open youtube tabs, and every refresh ages your export. closing it is what makes these last.",
  "cookies.step6": "import that file here",

  "cookies.importing": "importing…",
  "cookies.replace": "replace…",
  "cookies.tryAgain": "try again…",
  "cookies.import": "import cookies…",
  "cookies.testing": "testing…",
  "cookies.test": "test",
  "cookies.remove": "remove",

  "cookies.footerSignedIn":
    "youtube rotates these out eventually. when it does, cliply will say so right here.",
  "cookies.footer":
    "nothing here is sent anywhere. the file only ever goes to youtube, from your own machine.",

  "cookies.imported": "cookies imported",
  "cookies.importedDesc": "youtube will see you as signed in from now on.",
  "cookies.notSignedIn": "imported, but not signed in",
  "cookies.notSignedInDesc": "these cookies won't sign you in.",
  "cookies.importFailed": "couldn't import that file",
  "cookies.importFailedDesc": "couldn't import cookies",
  "cookies.turnedDown": "youtube turned these down",
  "cookies.lookFine": "cookies look fine",
  "cookies.notUsable": "cookies aren't usable",
  "cookies.testFailed": "couldn't test the cookies",
  "cookies.removeFailed": "couldn't remove the cookies",
  "cookies.removeFailedDesc": "they're still on this machine.",
  "cookies.copyFailed": "couldn't copy that",
  "cookies.copyFailedDesc": "type youtube.com/robots.txt into that tab instead.",

  "toast.overwhelmed": "we're overwhelmed",
  "toast.openFolder": "Open Folder",
  "toast.report": "report",
  "toast.fixWithCookies": "fix with cookies",
  "toast.botCookies": "signing in with a throwaway account usually clears this.",
  "toast.botGeneric": "this site wants us to prove we're not a bot.",
  "toast.audioDone": "Audio downloaded successfully!",
  "toast.videoDone": "Video downloaded successfully!",
  "toast.audioDoneDesc": "Your audio file has been downloaded to your device.",
  "toast.videoDoneDesc": "Your video file has been downloaded to your device.",

  "download.startingAudio": "Starting audio download...",
  "download.startingVideo": "Starting video download...",
  "download.audioProgress": "Downloading audio... {percent}%",
  "download.videoProgress": "Downloading video... {percent}%",
  "download.audioCompleted": "Audio download completed!",
  "download.videoCompleted": "Video download completed!",
  "download.saved": "Saved: {filename}",
  "download.audioFailed": "Audio download failed",
  "download.videoFailed": "Video download failed",
  // the one-button platforms, which do not say which kind of download it was
  "download.failed": "Download failed",
  "download.wentWrong": "Something went wrong. You can send us the details.",
  "download.startFailed": "Failed to start download: {message}",
  "download.cancelled": "Download cancelled",
  "download.audioCancelled": "Audio download cancelled",
  "download.videoCancelled": "Video download cancelled",
  "download.complete": "Download complete!",
  "download.video": "Download Video",
  "download.audio": "Download Audio",
  "download.inProgress": "Downloading...",
  "download.mergeHint": "Video and audio will be merged automatically",
  "download.audioHint":
    "Audio will be downloaded with the selected time range and format",

  "card.tabVideo": "Video Download",
  "card.tabAudio": "Audio Only",
  "card.videoIntro": "Download video with automatically paired audio",
  "card.audioIntro": "Extract audio from the video with custom time range",
  "card.summary": "Download Summary",
  "card.uploader": "Uploader:",
  "card.duration": "Duration:",
  "card.size": "Size:",
  "card.format": "Format:",
  "card.language": "Language:",
  "card.timeRange": "Time Range:",
  "card.videoQuality": "Video Quality:",
  "card.audioTrack": "Audio Track:",
  "card.bestAvailable": "Best available",
  "card.preciseCut": "Precise Cut:",
  "card.enabled": "Enabled",
  "card.disabled": "Disabled",
  "card.preciseCutHint": "Turn off for faster download but less precise cuts",
  "card.pinterestSubtitle": "Best available quality, saved as MP4.",
  "card.tiktokSubtitle":
    "Best available quality, saved as MP4. No watermark.",

  "dropdown.videoQuality": "Video Quality",
  "dropdown.videoQualityPlaceholder": "Select video quality...",
  "dropdown.audioFormat": "Audio Format",
  "dropdown.audioFormatPlaceholder": "Select audio format...",
  "dropdown.audioLanguage": "Audio Language",
  "dropdown.audioLanguagePlaceholder": "Select audio language...",
  "dropdown.selected": "Selected:",
  "dropdown.plusBestAudio": "+ best audio",
  "dropdown.original": "Original",
  "dropdown.noVideoStreams":
    "This link has no video streams to download, only audio. The Audio Only tab still works.",

  // the container names are the same word everywhere; they sit in the
  // dictionary only so the row beside them can be typed as a key
  "format.mp3": "MP3",
  "format.m4a": "M4A",
  "format.mp3Detail": "Converted · plays everywhere",
  "format.m4aDetail": "AAC · converted",
  "format.originalDetail": "Source quality, no re-encode · usually WEBM/Opus",

  "time.selection": "Time Range Selection",
  "time.range": "Time Range",
  "time.start": "Start Time",
  "time.end": "End Time",
  "time.selectedDuration": "Selected duration:",
  "time.helper": "Use MM:SS or HH:MM:SS format. Max duration: {max}",
  "time.helperShort": "Format: MM:SS or HH:MM:SS • Max duration: {max}",
  "time.invalid": "Invalid time range",
  "time.startNegative": "Start time cannot be negative",
  "time.endExceeds": "End time exceeds video duration",
  "time.endBeforeStart": "End time must be greater than start time",

  // the noun a progress line is about, interpolated into the lines below
  "media.video": "video",
  "media.audio": "audio",
  "progress.downloading": "Downloading {label}",
  "progress.processing": "Processing {label}",
  "progress.startingUp": "Starting up",
  "progress.trimming": "Progress isn't reported while trimming",
  "progress.stop": "Stop",
  "progress.stopTitle": "Stop this download",
  // what a bar with no position tells assistive tech
  "progress.working": "Working",

  "feedback.title": "Help us improve",
  "feedback.subtitle": "Request a feature",
  "feedback.cta": "tap me :)",

  "layout.downloadsAt": "Downloads stored at",
  "layout.concurrentNote":
    "Multiple downloads supported, performance may vary with concurrent downloads.",

  "thumb.unavailable": "Thumbnail unavailable",
  "thumb.viewOn": "View on {name}",
  "thumb.openFailed": "Could not open {name} link",
  "player.cantDisplay": "Can't display video",

  // version numbers and release notes are data, so they stay where they are
  "update.available": "Update Available",
  "update.macManual": "Version {version} requires manual download on Mac",
  "update.download": "Download",
  "update.downloadingTitle": "Update Downloading",
  "update.autoDownloading":
    "Version {version} is downloading automatically in the background",
  "update.readyToDownload": "Version {version} is ready to download",
  "update.upToDate": "App is up to date",
  "update.upToDateDesc": "You're running the latest version",
  "update.progress": "Downloading Update: {percent}%",
  "update.inBackground": "Downloading in background...",
  "update.readyToInstallToast": "Update Ready to Install!",
  "update.downloadedDesc":
    "Version {version} has been downloaded successfully. It will install when you close the app.",
  "update.installNow": "Install Now",
  "update.checking": "Checking for updates...",
  "update.error": "Update Error",
  "update.preparing": "Preparing download...",
  "update.preparingDesc": "Initializing update download",
  "update.started": "Download Started",
  "update.startedDesc":
    "Update is downloading in the background. You can continue using the app.",
  // title case, unlike the download card's own "Download failed"
  "update.downloadFailed": "Download Failed",
  "update.downloadFailedDesc": "Failed to download update",
  "update.checkConnection":
    "Please try again or check your internet connection",
  "update.installing": "Installing Update",
  "update.installingDesc": "The app will close and reopen with the new version",
  "update.installFailed": "Installation Failed",
  "update.installFailedDesc": "Please try downloading the update again",

  "update.cardDownloading": "Downloading Update",
  "update.cardProgress": "Version {version} • {percent}% complete",
  "update.cardReady": "Update Ready",
  "update.cardReadyDesc": "Version {version} is ready to install",
  "update.installRestart": "Install & Restart",
  "update.tryAgain": "Try Again",
  "update.importantUpdates": "Check for Important Updates",

  "update.macDesc":
    "We can't auto-update on Mac. Click 'Learn Why' to find out more.",
  "update.newVersion": "A new version of Cliply is available.",
  "update.version": "Version {version}",
  "update.released": "Released {date}",
  "update.later": "Later",
  "update.learnWhy": "Learn Why",
  "update.downloadFromGithub": "Download from GitHub",
  "update.downloadUpdate": "Download Update",
  "update.readyToInstall": "Update Ready to Install",
  "update.readyToInstallDesc":
    "The update has been downloaded and is ready to install. The app will restart automatically.",
  "update.whenReady": "Ready to install when you're ready",

  // only the dialog's own chrome. the issue this sends is written in english,
  // because the maintainers who read it are
  "report.title": "Report an issue",
  "report.description":
    "This opens a pre-filled draft issue on GitHub in your browser. Look it over there, then publish it when you're ready.",
  "report.whatWentWrong": "What went wrong",
  "report.yourSetup": "Your setup, attached as-is",
  "report.technicalDetails": "Technical details we'll attach",
  "report.show": "show",
  "report.notes": "Anything you were doing when it broke?",
  "report.notesPlaceholder": "Optional, but it helps us track it down faster.",
  "report.includeLink": "Include the link I was downloading",
  "report.notNow": "Not now",
  "report.openOnGithub": "Open on GitHub",
  "report.opening": "Opening GitHub",
  "report.trimmed":
    "We trimmed the logs to fit. The full report is on your clipboard.",
  "report.reviewIt": "Review the pre-filled issue and hit submit.",
  "report.browserFailed": "Couldn't open your browser",
  "report.browserFailedDesc":
    "The full report is on your clipboard. Paste it at github.com/Cliply/Cliply/issues/new",

  // main owns which download counts as a milestone, so the number is data
  "support.title": "that's {n} downloads",
  "support.description":
    "cliply is free, has no ads, and doesn't track you. it's built and kept working by one person in their spare time, mostly against youtube changing things on purpose.",
  "support.ask": "if it saved you some time, a coffee helps.",
  "support.decline": "no thanks"
} as const

export type Key = keyof typeof en
