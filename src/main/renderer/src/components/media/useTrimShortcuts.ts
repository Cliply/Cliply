import { useEffect } from "react"
import {
  editorActions,
  splitSection,
  deleteSection,
  type EditDocument
} from "@/lib/stores/editorStore"
import { localTrimActions } from "@/lib/stores/localExportStore"

type TrimShortcutsOptions = {
  locked: boolean
  edit: EditDocument
  currentTime: () => number
  seek: (time: number) => void
  mark: (edge: "start" | "end") => void
  commit: (edit: EditDocument) => void
  togglePlay: () => void
  stopPreview: () => void
}

export function useTrimShortcuts({
  locked,
  edit,
  currentTime,
  seek,
  mark,
  commit,
  togglePlay,
  stopPreview
}: TrimShortcutsOptions) {
  const range = edit.ranges[edit.active]
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (
        event.defaultPrevented ||
        locked ||
        event.altKey ||
        event.repeat ||
        target?.isContentEditable ||
        target?.closest(
          "input,textarea,select,[role=combobox],video,audio,[role=slider],[role=separator],[contenteditable]"
        )
      )
        return
      const key = event.key.toLowerCase()
      if (key === " " && target?.closest("button")) return
      if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault()
        stopPreview()
        localTrimActions.reset()
        if (event.shiftKey) editorActions.redo()
        else editorActions.undo()
      } else if (
        !event.metaKey &&
        !event.ctrlKey &&
        [
          "i",
          "o",
          "b",
          "delete",
          "backspace",
          " ",
          "arrowleft",
          "arrowright"
        ].includes(key)
      ) {
        event.preventDefault()
        if (key === "i" || key === "o") mark(key === "i" ? "start" : "end")
        else if (key === "b") commit(splitSection(edit, currentTime()))
        else if (["delete", "backspace"].includes(key))
          commit(deleteSection(edit))
        else if (key === " ") togglePlay()
        else if (event.shiftKey && range)
          seek(key === "arrowleft" ? range.start : range.end)
        else seek(currentTime() + (key === "arrowleft" ? -1 : 1))
      }
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  })
}
