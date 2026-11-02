// Inspection contract only. Stream indexes are FFprobe IDs, not array positions.
export interface MediaCapability {
  status: "available" | "unavailable" | "unchecked"
  reason: string | null
  message: string | null
}

export interface MediaStream {
  index: number
  type: string
  codec: string | null
  duration: number | null
  startTime: number | null
  timeBase: string | null
  width: number | null
  height: number | null
  pixelFormat: string | null
  sampleRate: number | null
  channels: number | null
  averageFrameRate: string | null
  language: string | null
  title: string | null
  disposition: Record<string, 0 | 1>
  rotation: number | null
}

export interface MediaSource {
  schemaVersion: 1
  sourceId: string
  filename: string
  bytes: number | null
  duration: number | null
  startTime: number | null
  formatNames: string[]
  streams: MediaStream[]
  chapterCount: number
  capabilities: Record<"probe" | "nativePreview" | "trim" | "extractAudio" | "removeTracks" | "remux", MediaCapability>
}

export interface MediaOpenResult {
  cancelled: boolean
  source: MediaSource | null
}

export interface MediaState {
  source: MediaSource | null
  busy: boolean
}

export interface MediaPreview {
  sourceId: string
  previewId: string
  url: string
  mime: string
  expiresAt: number
}
