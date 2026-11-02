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
  contentContainer?: MediaContainer | null
  chapters?: { start: number | null; end: number | null; title: string | null }[]
  chaptersCopySafe?: boolean
  trimProfile?: { extension: string; hasVideo: boolean } | null
  remuxProfiles?: { targetContainer: MediaContainer; extension: MediaContainer; supportedStreamIndexes: number[]; preservesChapters: boolean }[]
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

export type MediaContainer = "mp4" | "mov" | "mkv"
export interface AudioExportRequest { operation: "extractAudio"; sourceId: string; streamIndex: number }
export interface AudioExportPlan extends AudioExportRequest {
  planId: string; outputName: string; extension: string; codec: string; language: string | null; title: string | null; duration: number; expiresAt: number
}
export interface TrackExportRequest { operation: "removeTracks"; sourceId: string; streamIndexes: number[]; removeChapters: boolean }
export interface TrackExportPlan extends TrackExportRequest {
  planId: string; outputName: string; extension: string; duration: number; expiresAt: number; removedStreamIndexes: number[]
}
export interface RemuxRequest extends Omit<TrackExportRequest, "operation"> { operation: "remux"; targetContainer: MediaContainer }
export interface RemuxPlan extends Omit<TrackExportPlan, "operation"> { operation: "remux"; targetContainer: MediaContainer }
export interface TrimInspectRequest { sourceId: string; previewId: string; start: number; end: number; mode: "before" | "after" }
export interface TrimTiming {
  operation: "trim"; sourceId: string; trimPlanId: string; expiresAt: number; previewId: string
  requestedStart: number; requestedEnd: number; mode: "before" | "after"
  plannedStart: number; plannedEnd: number; tolerance: number; duration: number; extension: string; streamIndexes: number[]
}
export interface TrimExportRequest { operation: "trim"; sourceId: string; trimPlanId: string }
export interface TrimExportPlan extends TrimTiming { planId: string; outputName: string }
export type LocalExportRequest = AudioExportRequest | TrackExportRequest | RemuxRequest | TrimExportRequest
export type LocalExportPlan = AudioExportPlan | TrackExportPlan | RemuxPlan | TrimExportPlan
export interface LocalExportJob {
  jobId: string; sourceId?: string; streamIndex?: number; outputName: string | null
  operation?: LocalExportRequest["operation"]
  state: "reserved" | "running" | "validating" | "publishing" | "stopping" | "completed" | "cancelled" | "failed" | "interrupted"
  progress: number; error: string | null; cleanupWarning?: boolean
}
export interface LocalExportState {
  revision: number; preparing: boolean; plan: LocalExportPlan | null; job: LocalExportJob | null; recoveryError: string | null
}
