# LosslessCut media foundation

Reference: https://github.com/mifi/lossless-cut/tree/6fc47dd4cc81b72a8f1b3132c47a99880cd9bbdb
Latest checked revision d5812b61c1b96c5dfd4cc03d846890541e27b437 changes packaging only.

The owner requested direct implementation parity on 3 November 2026. This
supersedes the earlier source-informed original implementation decision.

- `local-media/losslesscut.js` adapts the supported single-input stream-copy
  branches of `useFfmpegOperations.ts` (`losslessCutSingle`, `concatFiles`) and
  `util/streams.ts`. Cut times go to FFmpeg unchanged; the two modes select
  input/output seeking. Matroska B-frame compensation, negative timestamps,
  faststart, stream maps and merge metadata follow upstream procedures.
- `local-media/losslesscut-preview.js` adapts `createMediaSourceProcess` from
  `src/main/ffmpeg.ts`, including its filter graph and fragmented MP4 encoding.
- The renderer compatibility player adapts `MediaSourcePlayer.tsx`: native
  master clock, MSE slave, bounded buffering, seek resets and playback sync.
  Diagnostic-only upstream timers, event listeners and progress logs are
  omitted; error diagnostics remain. The component accepts an opaque `sourceId`.
  Main owns the fixed 800px/30fps preview settings; the renderer retains the
  matching one-frame timestamp correction and upstream 30ms synchronization.

Integration adaptations: CommonJS in main, Cliply's existing authenticated
preload IPC instead of Electron remote, opaque source/session IDs, supervised
process lifetime, original identity checks, owned staging paths and atomic
no-clobber final publication. No downloader engine or queue is shared with
the editor. Preview encoding is never an export source.

Upstream author: Mikael Finstad and LosslessCut contributors. Upstream declares
GPL-2.0-only; its complete LICENSE is retained here. Cliply currently declares
GPL-3.0-only. Directly adapted code is not represented as independently authored
or license-cleared. Reconcile the grants and distribution terms before release;
the owner's instruction defers that decision, it does not change either grant.
