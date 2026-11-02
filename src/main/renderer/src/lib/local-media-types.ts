// Stream indexes are FFprobe IDs, not array positions.
export interface MediaCapability {
  status: "available" | "unavailable" | "unchecked"
  reason: string | null
  message: string | null
}

export interface MediaStream {
  index: number
  type: string
  codec: string | null
  profile?: string | null
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
  titleCopySafe?: boolean
  tags?: Record<string, string>
  colorTransfer?: string | null
  colorPrimaries?: string | null
  hasHdrMetadata?: boolean
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
  extractionProfiles?: { streamIndex: number; extension: "aac" | "mp3" | "wav" }[]
  majorBrand?: string | null
  tags?: Record<string, string>
  trackRemovalProfile?: { extension: "mp4" | "mov" | "mkv"; supportedStreamIndexes: number[] } | null
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

export interface AudioExportRequest { operation: "extractAudio"; sourceId: string; streamIndex: number }
export interface AudioExportPlan extends AudioExportRequest {
  planId: string; outputName: string; extension: string; codec: string; language: string | null; title: string | null; duration: number; expiresAt: number
}
export interface TrackExportRequest { operation: "removeTracks"; sourceId: string; streamIndexes: number[]; removeChapters: boolean }
export interface TrackExportPlan extends TrackExportRequest {
  planId: string; outputName: string; extension: string; duration: number; expiresAt: number; removedStreamIndexes: number[]
}
export type LocalExportRequest = AudioExportRequest | TrackExportRequest
export type LocalExportPlan = AudioExportPlan | TrackExportPlan
export interface LocalExportJob {
  jobId: string; sourceId?: string; streamIndex?: number; outputName: string | null
  operation?: LocalExportRequest["operation"]
  state: "reserved" | "running" | "validating" | "publishing" | "stopping" | "completed" | "cancelled" | "failed" | "interrupted"
  progress: number; error: string | null; cleanupWarning?: boolean
}
export interface LocalExportState {
  revision: number; preparing: boolean; plan: LocalExportPlan | null; job: LocalExportJob | null; recoveryError: string | null
}
