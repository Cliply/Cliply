import { create } from "zustand"
import type { EditRange } from "../local-media-types"

export interface EditDocument { ranges: EditRange[]; intent: "keep" | "remove"; active: number; mode: "before" | "after" }
export const initialEdit = (duration: number): EditDocument => ({ ranges: [{ start: 0, end: duration }], intent: "keep", active: 0, mode: "before" })
export function retainedSections(edit: EditDocument, duration: number): EditRange[] {
  if (edit.intent === "keep") {
    const retained: EditRange[] = []
    for (const range of edit.ranges) {
      const previous = retained.at(-1)
      if (previous && previous.end === range.start) previous.end = range.end
      else retained.push({ ...range })
    }
    return retained
  }
  const result: EditRange[] = []
  let start = 0
  for (const range of edit.ranges) {
    if (range.start > start) result.push({ start, end: range.start })
    start = range.end
  }
  if (start < duration) result.push({ start, end: duration })
  return result
}
export function setEdge(edit: EditDocument, edge: "start" | "end", time: number, duration: number): EditDocument {
  const range = edit.ranges[edit.active]
  if (!range || !Number.isFinite(time)) return edit
  const value = edge === "start" ? Math.max(edit.ranges[edit.active - 1]?.end ?? 0, Math.min(range.end - 0.1, time))
    : Math.min(edit.ranges[edit.active + 1]?.start ?? duration, Math.max(range.start + 0.1, time))
  return { ...edit, ranges: edit.ranges.map((item, index) => index === edit.active ? { ...item, [edge]: Number(value.toFixed(6)) } : item) }
}
export function splitSection(edit: EditDocument, time: number): EditDocument {
  const index = edit.ranges.findIndex(range => time - range.start >= 0.1 && range.end - time >= 0.1)
  if (index < 0 || edit.ranges.length >= 32) return edit
  const range = edit.ranges[index]
  return { ...edit, active: index + 1, ranges: [...edit.ranges.slice(0, index), { start: range.start, end: time }, { start: time, end: range.end }, ...edit.ranges.slice(index + 1)] }
}
export function addSection(edit: EditDocument, time: number, duration: number): EditDocument {
  if (edit.ranges.length >= 32 || edit.ranges.some(range => time >= range.start && time < range.end)) return edit
  const index = edit.ranges.findIndex(range => range.start > time)
  const at = index < 0 ? edit.ranges.length : index
  const end = edit.ranges[at]?.start ?? duration
  if (time < 0 || end - time < 0.1) return edit
  return { ...edit, active: at, ranges: [...edit.ranges.slice(0, at), { start: time, end }, ...edit.ranges.slice(at)] }
}
export const deleteSection = (edit: EditDocument): EditDocument => ({ ...edit, active: Math.max(0, edit.active - 1), ranges: edit.ranges.filter((_, index) => index !== edit.active) })

export const useEditor = create<{ sourceId: string | null; document: EditDocument; past: EditDocument[]; future: EditDocument[] }>(() => ({ sourceId: null, document: initialEdit(0), past: [], future: [] }))
export const editorActions = {
  open(sourceId: string, duration: number) {
    if (sourceId !== useEditor.getState().sourceId) useEditor.setState({ sourceId, document: initialEdit(duration), past: [], future: [] })
  },
  commit(document: EditDocument) {
    const current = useEditor.getState()
    if (JSON.stringify(current.document) === JSON.stringify(document)) return
    useEditor.setState({ document, past: [...current.past, current.document].slice(-100), future: [] })
  },
  select(active: number) { useEditor.setState(state => ({ document: { ...state.document, active } })) },
  undo() {
    const state = useEditor.getState(), document = state.past.at(-1)
    if (document) useEditor.setState({ document, past: state.past.slice(0, -1), future: [state.document, ...state.future] })
  },
  redo() {
    const state = useEditor.getState(), document = state.future[0]
    if (document) useEditor.setState({ document, past: [...state.past, state.document], future: state.future.slice(1) })
  }
}
