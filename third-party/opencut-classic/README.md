# OpenCut Classic editor UI

The local editor adapts UI code from [OpenCut Classic](https://github.com/OpenCut-app/opencut-classic/tree/cf5e79e919144200294fb9fed22a222592a0aeea),
pinned at `cf5e79e919144200294fb9fed22a222592a0aeea`. The archived Classic
repository contains the working React editor; the newer OpenCut rewrite is not
the source of this integration. Cliply maintains these adapted files locally.

Upstream source and integration:

| Upstream path under `apps/web/src/` | Cliply adaptation |
| --- | --- |
| `components/ui/resizable.tsx` | Resizable panel primitives using upstream's `react-resizable-panels` 2.1.7 dependency; imports and Tailwind utilities mapped to Cliply |
| `app/editor/[project_id]/page.tsx`, `components/editor/editor-header.tsx` | Compact header, independently scrolling panels and nested horizontal/vertical workspace layout; Cliply tools replace assets and properties |
| `timeline/ruler-utils.ts`, `timeline/zoom-utils.ts` | Timeline tick density and zoom helpers, adapted to seconds and Cliply's bounded zoom |
| `timeline/components/timeline-ruler.tsx`, `timeline-tick.tsx`, `timeline-playhead.tsx`, `timeline-toolbar.tsx` | Visible ruler ticks, playhead and compact grouped controls, connected to Cliply's existing edit state |

Only supported Cliply actions appear. This does not import OpenCut's composition
engine, WASM time model, rendering/export pipeline, Next.js services, media
library, effects or project storage. Native and compatibility playback, cutting,
joining and original-file export continue to use the
[LosslessCut adaptations](../losslesscut/README.md). Preview resizing only changes
the presentation of those players. Downloader state and its engine are separate.

The OpenCut MIT grant and copyright are retained in `LICENSE`.
`react-resizable-panels-LICENSE` retains Brian Vaughn's MIT notice from tag
`2.1.7`. This directory is included in the packaged application alongside the
LosslessCut provenance. Source comments identify copied or adapted UI helpers;
style-only changes to existing Cliply tools remain original Cliply code.
