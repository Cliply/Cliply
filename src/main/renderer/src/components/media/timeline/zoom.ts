// Adapted from OpenCut Classic (MIT), cf5e79e919144200294fb9fed22a222592a0aeea:
// apps/web/src/timeline/zoom-utils.ts. See third-party/opencut-classic/README.md.
export const MAX_ZOOM = 64
export function sliderToZoom(sliderPosition: number) {
  const clampedPosition = Math.max(0, Math.min(1, sliderPosition))
  return MAX_ZOOM ** clampedPosition
}
export function zoomToSlider(zoomLevel: number) {
  const clampedZoom = Math.max(1, Math.min(MAX_ZOOM, zoomLevel))
  return Math.log(clampedZoom) / Math.log(MAX_ZOOM)
}
