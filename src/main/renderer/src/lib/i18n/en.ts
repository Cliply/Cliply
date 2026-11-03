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
  "media.editFormat": "Output: {format} · original-quality stream copy",
  "media.editVideo": "Cut video",
  "media.timeline": "Editing timeline",
  "media.timelineHint": "Drag the handles to mark a section. Green below shows what will be kept.",
  "media.zoomIn": "Zoom in",
  "media.zoomOut": "Zoom out",
  "media.zoom": "Timeline zoom",
  "media.resizePreview": "Resize preview and timeline",
  "media.resizeInspector": "Resize inspector",
  "media.source": "Source",
  "media.inspector": "Inspector",
  "media.section": "Section {number}",
  "media.undo": "Undo",
  "media.redo": "Redo",
  "media.playPause": "Play or pause",
  "media.split": "Split at cursor",
  "media.addSection": "Add section",
  "media.editMode": "What to export",
  "media.keepMarked": "Keep marked sections",
  "media.removeMarked": "Remove marked sections",
  "media.deleteMark": "Delete marking {number}",
  "media.keepMeaning": "Marked sections are kept and joined in source order. Deleting a marking excludes that section.",
  "media.removeMeaning": "Marked sections are removed. Everything around them is kept and joined in one file.",
  "media.previewEdit": "Preview retained video",
  "media.stopPreview": "Stop edit preview",
  "media.outputSummary": "{count} parts · {time} · one output",
  "media.preciseControls": "Precise times and keyboard shortcuts",
  "media.editorShortcuts": "Space: play/pause · I/O: mark in/out · B: split · Delete: delete marking · Ctrl/Cmd+Z: undo · Shift+Ctrl/Cmd+Z: redo. Preview follows requested boundaries.",
  "media.emptyEdit": "Nothing to export, or a remaining section is shorter than 0.1 seconds. Adjust the markings.",
  "media.compatibilityPreview": "Compatibility playback",
  "media.fastCutNote": "Keyframe cuts can include media before the marked start. Normal cuts can leave a brief gap before the first picture. These are requested times; check the exported result. The original stays unchanged.",
  "media.exportEdit": "Export edited video",
  "media.error.TRIM_CONTAINER": "Cutting supports MP4, MOV and compatible MKV video, plus M4A and WAV audio. Try Change format for this container.",
  "media.error.TRIM_VIDEO": "Cutting this video codec or HDR format is not implemented yet. H.264 SDR video is supported.",
  "media.error.TRIM_AUDIO": "This audio format is not supported for cutting yet. AAC-LC and HE-AAC mono/stereo at 44.1 or 48 kHz are supported.",
  "media.error.TRIM_CHAPTERS": "Chapter timing cannot be rewritten for cuts yet. Use Remove tracks to explicitly save a copy without chapters first.",
  "media.error.TRIM_OVERLAP": "Keyframe adjustments overlap two sections. Move their boundaries farther apart and review again.",
  "media.trackCopyNotice": "Keep the tracks you want in a new copy. Titles, language, rotation and ordinary file tags are preserved where supported. Matroska can assign a default audio/video track when none is selected as default. Other metadata depends on the format; this does not remove private metadata.",
  "media.removeAllAudio": "Remove all audio",
  "media.keepTracks": "Tracks to keep",
  "media.trackKept": "Kept",
  "media.trackRemoved": "Removed",
  "media.trackUnsupported": "Unverified; remove explicitly to continue",
  "media.removeChapters": "Remove all {count} chapters from this copy. Chapter preservation is not available.",
  "media.trackCopyResult": "Output: .{format} · same container · full file · original codecs",
  "media.fullFilePreview": "This operation uses the original file and does not require native preview.",
  "media.keptSummary": "Keep: {ids}",
  "media.removedSummary": "Remove: {ids}",
  "media.saveCopy": "Save copy",
  "media.copyRunning": "Saving selected tracks…",
  "media.copyValidating": "Checking the new copy…",
  "media.copyCompleted": "Copy saved",
  "media.copyCancelled": "Copy cancelled",
  "media.copyFailed": "Could not save the copy",
  "media.cancelCopy": "Cancel copy",
  "media.error.TRACK_CONTAINER": "Track removal needs a verified MP4, MOV or MKV file with known duration. For audio-only files, try Extract audio.",
  "media.error.TRACK_EMPTY": "Keep at least one playable video or audio track.",
  "media.error.TRACK_UNSUPPORTED": "A retained track has an unverified codec, metadata or disposition. Explicitly remove it to continue; no conversion is performed.",
  "media.error.TRACK_VIDEO_LIMIT": "Keep at most one video track for this copy.",
  "media.error.TRACK_CHAPTERS": "Confirm removal of chapters before saving this copy. Chapter preservation is not available for this operation.",
  "media.error.TRACK_DEFAULT": "This container would change a retained track's default flag. Keep the default track of that type too, or use Extract audio.",

  "media.exportStatus": "Local export",
  "media.exportProgress": "Local export progress",
  "media.exportReserved": "Preparing export…",
  "media.exportRunning": "Extracting audio…",
  "media.exportValidating": "Checking the extracted audio…",
  "media.exportPublishing": "Saving the completed file…",
  "media.exportStopping": "Stopping; waiting for the helper to exit…",
  "media.exportCompleted": "Audio saved",
  "media.exportCancelled": "Extraction cancelled",
  "media.exportFailed": "Extraction failed",
  "media.exportInterrupted": "Previous export interrupted",
  "media.cancelExport": "Cancel extraction",
  "media.revealOutput": "Show in folder",
  "media.exportFailureHelp": "Check the source, destination and available space, then try again.",
  "media.selectAudio": "Audio track to extract",
  "media.chooseTrack": "Choose one audio track",
  "media.audioResult": "Output: .{format} · original codec · full duration",
  "media.audioProfiles": "Verified profiles: AAC-LC, MP3 and 16-bit little-endian PCM; mono or stereo with a known duration. Other tracks cannot be extracted yet.",
  "media.noAudio": "This file has no audio track to extract.",
  "media.extractionNotice": "Only the selected audio is saved. Metadata depends on the output format. The original file stays open and unchanged.",
  "media.extractionPreview": "Extraction uses the original file and does not require native preview.",
  "media.chooseDestination": "Choose destination",
  "media.saveAs": "Save as: {name}",
  "media.error.AUDIO_UNSUPPORTED": "No verified audio extraction profile is available for this track. Choose AAC-LC, MP3 or 16-bit little-endian PCM, mono/stereo, with a known duration.",
  "media.error.OUTPUT_PATH": "Choose a local output folder and the displayed file extension.",
  "media.error.OUTPUT_EXISTS": "That output already exists. Choose a different name; existing files are never replaced.",
  "media.error.OUTPUT_SPACE": "The destination is out of space. Free space or choose another folder.",
  "media.error.OUTPUT_INVALID": "The exported file failed validation. No final file was published.",
  "media.error.OUTPUT_CHANGED": "The completed file changed or moved. Locate it in its destination folder.",
  "media.error.EXPORT_BUSY": "A local export or destination selection is active. Finish or cancel it before changing the source.",
  "media.error.EXPORT_FAILED": "Local export failed. Check the helpers, source and destination permissions, then try again.",
  "media.error.EXPORT_CANCELLED": "Local export was cancelled.",
  "media.error.EXPORT_TIMEOUT": "Local export exceeded its time limit.",
  "media.error.EXPORT_STUCK": "A local helper has not stopped. Wait and try again; installation and shutdown are blocked while it writes.",
  "media.error.EXPORT_CLEANUP": "An owned partial could not be safely cleaned. Check the destination before retrying; unrelated files will not be removed.",
  "media.error.EXPORT_INTERRUPTED": "The previous export was interrupted. Its owned partial was cleaned. Check the destination for any already completed output.",
  "media.error.PLAN_EXPIRED": "This export plan is no longer current. Choose the destination again.",
  "media.error.JOB_UNKNOWN": "This local export is no longer available.",
  "media.error.SOURCE_CHANGED": "The source changed. Reopen it before extracting audio.",
  "media.error.SOURCE_INVALID": "The source is no longer available. Reopen a local media file.",
  "media.error.PROBE_MISSING": "FFprobe is unavailable. Restore the verified helper before extracting audio.",
  "media.error.PROBE_TIMEOUT": "Audio validation timed out. No final file was published.",

  "media.open": "Open local file",
  "media.opening": "Inspecting local file…",
  "media.return": "Return to local file",
  "media.cancel": "Cancel",
  "media.back": "Back to downloads",
  "media.title": "Local media",
  "media.empty": "No file open",
  "media.emptyBody": "Open one video or audio file to inspect its tracks and preview it. Your downloads can continue.",
  "media.change": "Change file",
  "media.close": "Close file",
  "media.preview": "Native preview",
  "media.player": "Local media player",
  "media.audioPreview": "Audio preview",
  "media.loading": "Loading preview…",
  "media.ready": "Ready to play",
  "media.playing": "Playing",
  "media.seeking": "Seeking…",
  "media.ended": "Playback ended",
  "media.previewUnavailable": "Preview unavailable. This file may use a format the player cannot decode. File inspection is still available.",
  "media.expired": "Preview access expired. Reload the preview to continue.",
  "media.retryPreview": "Reload preview",
  "media.previewNote": "Preview uses the original file. The player chooses its default tracks; the list below shows every track.",
  "media.duration": "Duration",
  "media.unknown": "Unknown",
  "media.seconds": "{value} s",
  "media.size": "Size",
  "media.container": "Container family",
  "media.tracks": "Tracks",
  "media.trackId": "ID",
  "media.type": "Type",
  "media.codec": "Codec",
  "media.language": "Language",
  "media.trackTitle": "Title",
  "media.coverArt": "cover art",
  "media.chapters": "Chapters: {count}. All tracks are listed; preview support does not mean editing support.",
  "media.tools": "Local tools",
  "media.trimNotice": "Fast trim saves one section with the original codecs and track layout. Video starts follow keyframes; packet boundaries and reordered frames can move the end. Review the planned range before saving. No exact cuts or conversion.",
  "media.trimStart": "Start (seconds)",
  "media.trimEnd": "End (seconds)",
  "media.setStart": "Set start from playback",
  "media.setEnd": "Set end from playback",
  "media.seekTime": "Seek · {time} s",
  "media.trimShortcuts": "I: set start · O: set end · ←/→: seek 5 seconds. Shortcuts are inactive while typing.",
  "media.keyframeDirection": "Cut mode",
  "media.keyframeBefore": "Keyframe cut",
  "media.keyframeAfter": "Normal cut",
  "media.cancelTiming": "Cancel boundary check",
  "media.reviewCut": "Review export",
  "media.requestedCut": "Requested: {start}–{end} s",
  "media.plannedCut": "Requested section: {start}–{end} s",
  "media.cutTolerance": "End/duration tolerance: {milliseconds} ms. The start follows the planned boundary. Listen and watch the saved clip.",
  "media.trimResult": "Output: .{format} · original codecs · keep tracks {ids}",
  "media.saveClip": "Save clip",
  "media.clipRunning": "Saving clip",
  "media.clipValidating": "Checking clip",
  "media.clipCompleted": "Clip saved",
  "media.clipCancelled": "Clip cancelled",
  "media.clipFailed": "Clip could not be saved",
  "media.cancelClip": "Cancel clip",
  "media.error.TRIM_PROFILE": "This track metadata or layout cannot be preserved by cutting yet. Inspect the tracks or use a full-file tool.",
  "media.error.TRIM_STREAMS": "Cutting supports one video and up to 16 audio tracks. Use Remove tracks to explicitly save a copy without subtitles or other extra tracks first.",
  "media.error.TRIM_TIMING": "Missing, delayed or ambiguous timing is outside the verified fast-cut profile.",
  "media.error.TRIM_RANGE": "Choose a range of at least 0.1 seconds within the file. The planned start must be before the end.",
  "media.error.TRIM_KEYFRAME": "No usable keyframe was found in the bounded search. Adjust the start or choose the other direction.",
  "media.error.TRIM_PREVIEW": "Play or audition this source before reviewing boundaries and saving a clip.",
  "media.trim": "Trim",
  "media.extract": "Extract audio",
  "media.remove": "Remove tracks",
  "media.remuxResult": "Output: .{format} · full file · original codecs",
  "media.remuxNotice": "Change the container for the full file. Original codecs and quality are kept; file size may not become smaller. Remove incompatible tracks explicitly; no conversion is performed.",
  "media.targetContainer": "Output container",
  "media.chooseContainer": "Choose a container",
  "media.chaptersKept": "Keep all {count} chapters.",
  "media.error.REMUX_SOURCE": "Container changes need a verified MP4, MOV or Matroska source.",
  "media.error.REMUX_TARGET": "Choose a different supported output container.",
  "media.error.REMUX_CHAPTERS": "Chapters can be kept only for compatible MKV output. Choose MKV or explicitly remove the chapters.",
  "media.error.REMUX_TIMING": "Unknown or delayed track timing is outside the verified container-change profile.",
  "media.remux": "Change format",
  "media.toolsUnavailable": "Trim is not available yet.",
  "media.sessionOnly": "The open file and playback position stay in memory while you navigate. Closing the file or app discards them.",
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
  // youtube's box is the one that takes a playlist link, and the empty box is
  // the first place somebody looks to find out what it accepts
  "url.youtubePlaceholder": "paste a video or playlist url...",
  // the details screen asks for a replacement link
  "url.replacePlaceholder": "Enter new video URL...",
  "url.loading": "\u{1F40B} getting video information",
  "url.loaded": "Video information loaded successfully!",
  "url.selectFolder": "Select folder",
  "url.pickerBusy": "Wait for the current link to finish",
  // the box takes a playlist link now, and a helper line that only mentions
  // videos and shorts is the reason somebody would never try one.
  //
  // three keys rather than one because the middle word is a link that fills the
  // box with a playlist: same reason cookies.stillHere is split around its
  // count, and the halves carry their own spacing so word order can differ
  "url.youtubeHelper": "supports youtube videos, shorts & ",
  "url.youtubeHelperPlaylists": "playlists",
  "url.youtubeHelperRest": " from youtube.com and youtu.be",
  "url.pinterestHelper":
    "supports pin.it and pinterest.com/pin links, any country domain",
  "url.tiktokHelper":
    "supports tiktok.com/@user/video/ID, vm.tiktok.com, and vt.tiktok.com links",

  // the two toasts a playlist link sends from the search box
  "playlist.loaded": "Playlist loaded successfully!",
  "playlist.infoFailed": "Failed to get playlist information",

  /**
   * the playlist screens: the listing on the left, the card on the right, and
   * what a run says about itself
   *
   * every sentence that counts something is built from pieces that are each
   * translated whole and joined by the same punctuation in both languages.
   * gluing translated fragments together in english word order is the one
   * thing this section must never do, because russian does not share it.
   */

  // the header over the listing
  "playlist.videoCount": "{n} video|{n} videos",
  "playlist.showingFirst": "Showing the first {listed} of {count} videos",
  "playlist.totalHours": "{hours} h {minutes} m total",
  "playlist.totalMinutes": "{minutes} m total",

  // the toolbar above the rows
  "playlist.selectAll": "Select all",
  "playlist.selectNone": "Select none",
  "playlist.selectedCount": "{n} of {total} selected",
  "playlist.perVideoStatus": "Per video status",
  "playlist.badgeDone": "{n} done",
  "playlist.badgeDownloading": "{n} downloading",

  // one row's badge. the height a save came down at is data, not a word
  "playlist.rowSaved": "saved",
  "playlist.rowSavedAt": "saved · {height}p",
  "playlist.rowReused": "already downloaded",
  "playlist.rowNotSaved": "not saved",
  "playlist.rowQueued": "queued",
  "playlist.rowStopping": "stopping",
  "playlist.rowUnavailable": "unavailable",

  // the picker
  "playlist.tabVideo": "Video",
  "playlist.qualityHeading": "Quality",
  "playlist.qualityPlaceholder": "Select a quality limit...",
  // the six rows differ only by a height, which is the same in any language
  "playlist.ceilingLabel": "Up to {limit}",
  "playlist.ceilingHelper":
    "Each video is saved as MP4 at its best quality up to {limit}, with its original audio.",
  "playlist.videoIntro":
    "One quality for the whole playlist. Video and audio are merged automatically.",
  "playlist.audioIntro":
    "Take the audio from every video you picked, in one format.",
  "playlist.audioNote":
    "Each video is saved whole, in the format picked above.",
  "playlist.pickVideosFirst": "Pick some videos first",
  "playlist.pickTracksFirst": "Pick some tracks first",
  "playlist.downloadVideos": "Download {n} video|Download {n} videos",
  "playlist.downloadTracks": "Download {n} track|Download {n} tracks",

  // the run
  "playlist.starting": "Starting playlist download...",
  "playlist.videoOf": "Video {current} of {total}",
  "playlist.thisVideo": "This video",
  "playlist.cancelRemaining": "Cancel remaining",
  "playlist.cancelKeepsHint":
    "Videos already saved are kept. Running it again skips them.",

  // how it ended
  "playlist.completed": "Playlist download completed!",
  "playlist.finished": "Playlist download finished",
  "playlist.cancelled": "Playlist download cancelled",
  "playlist.cancelledToast":
    "Videos already saved are kept. Re-running skips them.",
  "playlist.cancelledHint":
    "Videos already saved are kept. Running it again picks up where this one stopped.",
  "playlist.failed": "Playlist download failed",
  // the three pieces of "8 of 9 videos saved, 2 already downloaded, 1 skipped."
  "playlist.summarySaved":
    "{saved} of {n} video saved|{saved} of {n} videos saved",
  "playlist.summaryReused": "{n} already downloaded",
  "playlist.summarySkipped": "{n} skipped",
  // the ones the run did not save, named. a single miss is named without a
  // count, which is a rule about the sentence rather than about grammar - so
  // it is a branch in code rather than the `one` form of a plural set
  "playlist.notSavedOne": "Not saved: {names}.",
  "playlist.notSavedMany": "{n} not saved: {names}.",
  "playlist.quotedName": '"{title}"',
  "playlist.andMore": "{n} more",
  "playlist.listJoin": "{items} and {last}",
  "playlist.retryFailed": "Retry the {n} that failed",
  "playlist.downloadAgain": "Download everything again",
  "playlist.pickAgain": "Pick videos again",

  // a start the screen refused before anything ran
  "playlist.errorNoPlaylist": "Load a playlist before downloading it.",
  "playlist.errorNoId": "This link doesn't name a playlist we can download.",
  "playlist.errorNoSelection": "Select at least one video to download.",
  "playlist.errorBusy": "A playlist download is already running.",

  // the question a watch?v=…&list=… link asks
  "mixedLink.title": "This link is part of a playlist",
  "mixedLink.videoChoice": "Just this video",
  "mixedLink.videoHint": "The one the link opens",
  "mixedLink.playlistChoice": "All {n} video|All {n} videos",
  // a listing we only hold the first hundred of is not all of it, so the
  // button counts what it will really download rather than promising all
  "mixedLink.playlistFirst": "The first {n} videos",
  "mixedLink.playlistHint": "Open the playlist",

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
  "cookies.copyFailedDesc":
    "type youtube.com/robots.txt into that tab instead.",

  "toast.overwhelmed": "we're overwhelmed",
  "toast.openFolder": "Open Folder",
  "toast.report": "report",
  "toast.fixWithCookies": "fix with cookies",
  "toast.botCookies":
    "signing in with a throwaway account usually clears this.",
  "toast.botGeneric": "this site wants us to prove we're not a bot.",

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

  /**
   * the panel on the right edge: every download this install has started, and
   * what each row offers to do about it
   *
   * the chip beside a title is assembled from the request rather than kept as
   * a sentence, so a playlist's count reads through `playlist.videoCount` and
   * an audio mode through the `format.*` names the dropdown already uses. only
   * the two platform names are here, because nothing else in the app had them
   * as words of their own.
   */
  "downloads.title": "Downloads",
  "downloads.toggle": "Show downloads",
  /**
   * the label under the one number at the top of the panel
   *
   * both forms are the same sentence in english, and it is still written as a
   * plural: `ru.ts` is typed against this file, so the russian - which does
   * decline - only gets its three forms if the key is plural here.
   */
  "downloads.mediaDownloaded": "media downloaded|media downloaded",
  "downloads.clearHistory": "Clear history",
  // the middle of an empty list. it says nothing about downloads: the lifetime
  // number above it has already said that, and this is the list speaking
  "downloads.nothingToShow": "Nothing to show",
  // a row whose title main never learned, which is any download started from a
  // link that failed before the lookup answered
  "downloads.untitled": "Untitled",
  "downloads.queued": "Queued",
  "downloads.cancelled": "Cancelled",
  "downloads.interrupted": "Interrupted",
  // a playlist's position inside its own run: "3 of 12"
  "downloads.itemsProgress": "{done} of {total}",
  "downloads.retry": "Retry",
  "downloads.retryUnavailable":
    "We didn't keep enough about this one to start it again",
  "downloads.retryFailed": "Couldn't start that download again",

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
  "card.tiktokSubtitle": "Best available quality, saved as MP4. No watermark.",

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
  // three downloads run at a time; this one is next in line
  "progress.queued": "Waiting its turn",
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
