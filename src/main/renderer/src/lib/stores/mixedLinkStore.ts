import type { PlaylistInfoResponse } from "@/lib/api"
import type { YouTubeTarget } from "@/lib/validation"

import { create } from "zustand"

/**
 * which of the two things a `watch?v=…&list=…` link names the user meant
 *
 * `video` is what Cliply has always taken out of such a link, and it stays the
 * default. `playlist` is the answer the link's `list=` parameter was there for
 * all along.
 */
export type MixedLinkChoice = "video" | "playlist"

/**
 * the question, and what to do with its answer
 *
 * `info` is the listing, already fetched: the question is only worth asking
 * because it can name the playlist and say how big it is, and "All videos in
 * the playlist" is not a decision anybody can make. `choose` is the pair of
 * flows the submit closed over, so answering runs the same code the submit
 * would have run on its own.
 */
export interface MixedLinkQuestion {
  info: PlaylistInfoResponse
  choose: (choice: MixedLinkChoice) => void
}

/**
 * one ambiguous link, in the only terms two of its shapes agree on
 *
 * `watch?v=ID&list=LIST` off the address bar and `youtu.be/ID?list=LIST` off
 * the share sheet are the same question, and the share sheet adds an `si=` of
 * its own, so the raw text is the one thing that cannot key the answer.
 */
export const mixedLinkKey = (target: YouTubeTarget): string =>
  `${target.videoId ?? ""}:${target.listId ?? ""}`

interface MixedLinkState {
  /** the question on screen, or none */
  question: MixedLinkQuestion | null
  ask: (question: MixedLinkQuestion) => void
  answer: (choice: MixedLinkChoice) => void
  /** closed without answering: the paste is abandoned and nothing is learned */
  dismiss: () => void

  /**
   * what was answered about which link, for as long as the app is running.
   *
   * **keyed by the link, and never written anywhere.** the right answer differs
   * from link to link - one video out of a playlist today, the whole of another
   * one tomorrow - so a single sticky "always do this" would eventually
   * download two hundred videos for somebody who wanted one. remembering per
   * link only ever repeats an answer the user gave about that exact link, and
   * it is gone when the app closes.
   */
  answers: Map<string, MixedLinkChoice>
  remember: (key: string, choice: MixedLinkChoice) => void
  recall: (key: string) => MixedLinkChoice | null

  /** everything forgotten, for tests and for a full teardown */
  reset: () => void
}

export const useMixedLinkStore = create<MixedLinkState>((set, get) => ({
  question: null,
  answers: new Map<string, MixedLinkChoice>(),

  ask: (question) => set({ question }),

  /**
   * the question goes before its answer runs.
   *
   * `choose` reveals a view, and leaving the dialog up over the thing it just
   * opened is the one ordering that looks broken.
   */
  answer: (choice) => {
    const { question } = get()
    if (!question) return

    set({ question: null })
    question.choose(choice)
  },

  dismiss: () => set({ question: null }),

  remember: (key, choice) => {
    const answers = new Map(get().answers)
    answers.set(key, choice)
    set({ answers })
  },

  recall: (key) => get().answers.get(key) ?? null,

  reset: () => set({ question: null, answers: new Map() })
}))
