// Adapted from OpenCut Classic's components/ui/resizable.tsx (MIT).
// Source revision and license: third-party/opencut-classic/README.md.
import type { ComponentProps } from "react"
import * as ResizablePrimitive from "react-resizable-panels"
import { cn } from "@/lib/utils"

export function ResizablePanelGroup({ className, ...props }: ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return <ResizablePrimitive.PanelGroup className={cn("flex size-full data-[panel-group-direction=vertical]:flex-col", className)} {...props} />
}

export const ResizablePanel = ResizablePrimitive.Panel

export function ResizableHandle({ className, ...props }: ComponentProps<typeof ResizablePrimitive.PanelResizeHandle>) {
  return <ResizablePrimitive.PanelResizeHandle
    className={cn("editor-resize-handle relative flex w-1 shrink-0 items-center justify-center bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[panel-group-direction=vertical]:h-1 data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-1 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:translate-x-0 data-[panel-group-direction=vertical]:after:-translate-y-1/2", className)}
    {...props}
  />
}
