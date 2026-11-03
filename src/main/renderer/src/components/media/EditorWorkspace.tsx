import { useEffect, useRef, useState, type ReactNode } from "react"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useT } from "@/lib/i18n"

function panelMinimums(width: number, height: number) {
  // Panel percentages exclude the 4px divider. Reserve the player first:
  // Windows' frame/menu leave less content height than macOS at 800x600.
  const available = Math.max(1, height - 4)
  const preview = Math.min(180, available / 2)
  return {
    inspector: Math.min(48, 260 / Math.max(1, width) * 100),
    preview: preview / available * 100,
    timeline: Math.min(280, available - preview) / available * 100
  }
}

// Adapted from OpenCut Classic's editor/[project_id]/page.tsx (MIT).
// Keep the preview mounted when switching tools; only the lower pane and
// inspector contents change. Cliply's media player remains the playback owner.
// Source revision and license: third-party/opencut-classic/README.md.
export function EditorWorkspace({ preview, inspector, timeline }: {
  preview: ReactNode; inspector: ReactNode; timeline: ReactNode
}) {
  const t = useT()
  const container = useRef<HTMLDivElement>(null)
  const [minimums, setMinimums] = useState(() => panelMinimums(window.innerWidth - (window.innerWidth <= 1000 ? 66 : 98), window.innerHeight - 84))
  useEffect(() => {
    const node = container.current
    if (!node || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return
      // The upstream panel library owns resizing; convert readable pixel minima
      // into its percentage constraints as the desktop window changes size.
      setMinimums(panelMinimums(entry.contentRect.width, entry.contentRect.height))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return <div ref={container} className="editor-panels"><ResizablePanelGroup direction="horizontal" id="media-workspace-panels">
    <ResizablePanel id="media-canvas" order={1} defaultSize={72} minSize={48}>
      <ResizablePanelGroup direction="vertical" id="media-preview-timeline">
        <ResizablePanel id="media-preview-pane" order={1} defaultSize={56} minSize={minimums.preview} className="editor-preview-pane">
          {preview}
        </ResizablePanel>
        <ResizableHandle aria-label={t("media.resizePreview")} />
        <ResizablePanel id="media-timeline-pane" order={2} defaultSize={44} minSize={minimums.timeline} maxSize={70}>
          <div className="editor-timeline-pane">{timeline}</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </ResizablePanel>
    <ResizableHandle aria-label={t("media.resizeInspector")} />
    <ResizablePanel id="media-inspector-pane" order={2} defaultSize={28} minSize={minimums.inspector} maxSize={48}>
      <aside className="editor-inspector" aria-label={t("media.inspector")}>{inspector}</aside>
    </ResizablePanel>
  </ResizablePanelGroup></div>
}
