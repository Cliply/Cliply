import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { Film, Loader2, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { mediaApi } from "@/lib/api"
import { useT, type Key } from "@/lib/i18n"
import type { MediaPreview, MediaSource } from "@/lib/local-media-types"
import { localMediaActions, useLocalMedia } from "@/lib/stores/localMediaStore"

import MediaSourcePlayer from "./MediaSourcePlayer"

const previewStyle = { width: "100%", height: "100%", objectFit: "contain" as const }
type Status = "loading" | "ready" | "playing" | "seeking" | "ended" | "failed" | "expired"
const statusKeys: Record<Status, Key> = {
  loading: "media.loading", ready: "media.ready", playing: "media.playing", seeking: "media.seeking",
  ended: "media.ended", failed: "media.previewUnavailable", expired: "media.expired"
}

export function NativeMediaPlayer({ source, busy, mediaRef }: { source: MediaSource; busy: boolean; mediaRef?: RefObject<HTMLMediaElement | null> }) {
  const t = useT()
  const element = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const playbackRevision = useRef(0)
  const trackPosition = useRef(false)
  const [preview, setPreview] = useState<MediaPreview | null>(null)
  const [status, setStatus] = useState<Status>("loading")
  const [compatibility, setCompatibility] = useState(false)
  const [clockReady, setClockReady] = useState(false)
  const compatFailed = useCallback(() => setStatus("failed"), [])
  const previewVideo = useMemo(() => source.streams.find(s => s.type === "video" && !s.disposition.attached_pic), [source.streams])
  const previewAudio = useMemo(() => {
    const streams = source.streams.filter(s => s.type === "audio")
    const stream = streams.find(s => s.disposition.default) || streams[0]
    return stream ? [{ index: stream.index, channels: stream.channels ?? undefined }] : []
  }, [source.streams])
  const [attempt, setAttempt] = useState(0)
  const video = source.streams.some((s) => s.type === "video" && !s.disposition.attached_pic)
  const Player = video ? "video" : "audio"

  useEffect(() => {
    let alive = true
    let grant: MediaPreview | null = null
    let expiry: ReturnType<typeof setTimeout>
    let objectUrl: string | undefined
    setClockReady(false)
    const media = element.current
    setPreview(null)
    setStatus("loading")
    const reset = () => {
      playbackRevision.current += 1
      useLocalMedia.setState({ auditionPreviewId: null })
      // load() emits a timeupdate at zero when unloading. That is cleanup,
      // not a new playback position to restore after expiry or retry.
      const wasTracking = trackPosition.current
      trackPosition.current = false
      if (!media) return
      if (wasTracking && media.readyState > 0) localMediaActions.rememberPosition(source.sourceId, media.currentTime)
      media.pause()
      media.removeAttribute("src")
      media.load()
    }
    void mediaApi.preview(source.sourceId).then(async (result) => {
      grant = result
      if (!alive) { void mediaApi.releasePreview(result.previewId).catch(() => {}); return }
      if (compatibility) {
        const bytes = await mediaApi.compatClock(source.sourceId)
        if (!alive) return
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "audio/flac" }))
        setPreview({ ...result, url: objectUrl })
      } else setPreview(result)
      expiry = setTimeout(() => {
        reset()
        setPreview(null)
        setStatus("expired")
        void mediaApi.releasePreview(result.previewId).catch(() => {})
      }, Math.max(0, result.expiresAt - Date.now()))
    }).catch(() => { if (alive) setStatus("failed") })
    return () => {
      alive = false
      clearTimeout(expiry)
      reset()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      if (grant) void mediaApi.releasePreview(grant.previewId).catch(() => {})
    }
  }, [source.sourceId, attempt, compatibility])

  const reportPlayback = (played: boolean) => {
    const current = ++playbackRevision.current
    if (!played) useLocalMedia.setState({ auditionPreviewId: null })
    if (!preview) return
    void mediaApi.confirmPlayback({ previewId: preview.previewId, played }).then(result => {
      if (current === playbackRevision.current && element.current && result.confirmed && useLocalMedia.getState().source?.sourceId === source.sourceId) {
        useLocalMedia.setState({ auditionPreviewId: preview.previewId })
      }
    }).catch(() => { if (current === playbackRevision.current) useLocalMedia.setState({ auditionPreviewId: null }) })
  }
  useEffect(() => { if (busy) element.current?.pause() }, [busy])
  const failed = status === "failed" || status === "expired"
  return <section aria-label={t("media.preview")} className="space-y-3">
    <div className="relative rounded-xl border border-slate-300/50 bg-slate-950 p-2 dark:border-slate-700/50">
      {!video && <div className="flex h-32 items-center justify-center gap-3 text-slate-300"><Film />{t("media.audioPreview")}</div>}
      <Player ref={node => { element.current = node; if (mediaRef) mediaRef.current = node }} src={preview?.url} controls controlsList="nodownload noremoteplayback" disablePictureInPicture preload="metadata" aria-label={t("media.player")}
        className={video ? "aspect-video max-h-[32vh] w-full rounded-lg object-contain" : "w-full"}
        onLoadedMetadata={(event) => {
          const media = event.currentTarget
          // Like LosslessCut's canHtml5PlayerPlayStreams, detect a file whose
          // audio loaded but whose video track Chromium silently skipped.
          const audioTracks = (media as HTMLMediaElement & { audioTracks?: { length: number } }).audioTracks
          if (!compatibility && ((video && !(media as HTMLVideoElement).videoWidth) || (previewAudio.length > 0 && audioTracks?.length === 0))) {
            setCompatibility(true)
            return
          }
          const position = useLocalMedia.getState().position
          if (position > 0 && Number.isFinite(media.duration) && position < media.duration) media.currentTime = position
          trackPosition.current = true
          setClockReady(true)
        }}
        onCanPlay={() => { if (preview && !failed) setStatus("ready") }}
        onPlaying={() => { setStatus("playing"); reportPlayback(true) }}
        onPause={(event) => { if (preview && !failed) setStatus(event.currentTarget.ended ? "ended" : "ready") }}
        onWaiting={() => { if (!failed) setStatus("loading") }}
        onSeeking={() => { if (!failed) setStatus("seeking") }}
        onSeeked={(event) => { if (!failed) setStatus(event.currentTarget.paused ? "ready" : "playing") }}
        onTimeUpdate={(event) => {
          if (trackPosition.current) localMediaActions.rememberPosition(source.sourceId, event.currentTarget.currentTime)
        }}
        onEnded={() => setStatus("ended")}
        onError={() => { if (preview) { reportPlayback(false); if (!compatibility) setCompatibility(true); else setStatus("failed") } }}
      />
      {compatibility && clockReady && preview && <MediaSourcePlayer filePath={source.sourceId} videoStream={previewVideo ? { index: previewVideo.index } : undefined}
        audioStreams={previewAudio} masterVideoRef={element} rotate={undefined} mediaSourceQuality={0} ffmpegHwaccel="none" baseVideoStyle={previewStyle} onFailure={compatFailed} />}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role={failed ? "alert" : "status"} className={failed || status === "loading" ? "flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300" : "sr-only"}>
        {status === "loading" && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{t(statusKeys[status])}
      </p>
      {!compatibility && <Button size="sm" variant="ghost" onClick={() => setCompatibility(true)}>{t("media.compatibilityPreview")}</Button>}
      {compatibility && <span className="text-xs text-slate-500">{t("media.compatibilityPreview")}</span>}
      {failed && <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}><RotateCcw />{t("media.retryPreview")}</Button>}
    </div>

  </section>
}
