// @vitest-environment jsdom
//
// partial success is the outcome this card exists for. a playlist that saved
// eight of nine is eight videos the user now has, and drawing an error over it
// hides that; a playlist that "saved" five it actually skipped through the
// archive is a claim about files we did not write.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { PlaylistEntry, PlaylistInfoResponse } from "@/lib/api"
import type { PlaylistDownloadState } from "@/lib/hooks/usePlaylistDownload"
import { useLocale } from "@/lib/i18n"
import { en } from "@/lib/i18n/en"
import { usePlaylistStore } from "@/lib/playlistStore"
import { PlaylistSummary } from "./PlaylistSummary"

const entry = (index: number, title: string): PlaylistEntry => ({
  index,
  id: `video${index}`,
  title,
  duration: 60,
  duration_string: "1:00",
  thumbnail: null,
  unavailable: false
})

const listing = (entries: PlaylistEntry[]): PlaylistInfoResponse => ({
  playlist_id: "PL123",
  title: "Short talks",
  uploader: "TED",
  count: entries.length,
  listed: entries.length,
  truncated: false,
  entries
})

const NINE = listing([
  entry(1, "The Power of Imagination"),
  entry(2, "Why I Love My Bad Days"),
  entry(3, "3 Things I Wish I Knew When I Was Broke"),
  entry(4, "How I Turned Frustration Into Creative Speed"),
  entry(5, "The Secret to Giving Great Feedback"),
  entry(6, "Small Habits, Big Outcomes"),
  entry(7, "What Nobody Tells You About Focus"),
  entry(8, "A Better Way to Say No"),
  entry(9, "The Case for Boredom")
])

const finished = (
  overrides: Partial<PlaylistDownloadState> = {}
): PlaylistDownloadState => ({
  status: "completed",
  progress: 100,
  itemsSaved: 9,
  itemsReused: 0,
  itemsSkipped: 0,
  itemsTotal: 9,
  ...overrides
})

const handlers = () => ({
  onRun: vi.fn(),
  onRetry: vi.fn(),
  onPickAgain: vi.fn()
})

/** mark rows saved, as a finished run would have */
function markSaved(indices: number[], state: "saved" | "reused" = "saved") {
  const store = usePlaylistStore.getState()

  for (const index of indices) {
    store.setItemStatus(index, { state, progress: 100 })
  }
}

beforeEach(() => {
  usePlaylistStore.getState().reset()
  usePlaylistStore.getState().setLoadedPlaylist("https://youtube.com/playlist?list=PL123", NINE)
})
afterEach(cleanup)

describe("a partial run", () => {
  test("reads as what it saved, not as a failure", () => {
    markSaved([1, 2, 4, 5, 6, 7, 8, 9])

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 8, itemsSkipped: 1 })}
        {...handlers()}
      />
    )

    expect(screen.getByText("8 of 9 videos saved, 1 skipped.")).toBeDefined()
    expect(screen.queryByText(en["playlist.failed"])).toBeNull()
    expect(screen.getByRole("button", { name: en["toast.openFolder"] })).toBeDefined()
  })

  test("names the video that did not make it", () => {
    markSaved([1, 2, 4, 5, 6, 7, 8, 9])

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 8, itemsSkipped: 1 })}
        {...handlers()}
      />
    )

    // "1 skipped" alone leaves the user to diff a folder against a playlist
    expect(
      screen.getByText(/Not saved: "3 Things I Wish I Knew When I Was Broke"\./)
    ).toBeDefined()
  })

  test("names three and counts the rest", () => {
    markSaved([1, 2, 3, 4, 5])

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 5, itemsSkipped: 4 })}
        {...handlers()}
      />
    )

    const line = screen.getByText(/4 not saved:/)
    expect(line.textContent).toContain('"Small Habits, Big Outcomes"')
    expect(line.textContent).toContain('"What Nobody Tells You About Focus"')
    expect(line.textContent).toContain('"A Better Way to Say No"')
    // the fourth is counted rather than named: the list is right there on the
    // left, and this card is not a second copy of it
    expect(line.textContent).toContain("and 1 more")
    expect(line.textContent).not.toContain("The Case for Boredom")
  })

  test("offers a retry that asks for exactly the ones that failed", () => {
    markSaved([1, 2, 4, 5, 6, 7, 8])
    const on = handlers()

    render(
      <PlaylistSummary state={finished({ itemsSaved: 7, itemsSkipped: 2 })} {...on} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Retry the 2 that failed" }))

    expect(on.onRetry).toHaveBeenCalledWith([3, 9])
  })

  test("a single failure is retried in the singular", () => {
    markSaved([1, 2, 3, 4, 5, 6, 7, 8])

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 8, itemsSkipped: 1 })}
        {...handlers()}
      />
    )

    expect(screen.getByRole("button", { name: "Retry the 1 that failed" })).toBeDefined()
  })
})

/**
 * an archive skip records that a download once succeeded, not that the file is
 * on disk now: a new destination or a deleted file skips exactly the same. so
 * it is never folded into the saves, and the way out of it is offered.
 */
describe("videos the archive already had", () => {
  test("are counted separately from what this run wrote", () => {
    markSaved([1, 2, 3])
    markSaved([4, 5], "reused")

    render(
      <PlaylistSummary
        state={finished({
          itemsSaved: 3,
          itemsReused: 2,
          itemsSkipped: 1,
          itemsTotal: 6
        })}
        {...handlers()}
      />
    )

    expect(
      screen.getByText("3 of 6 videos saved, 2 already downloaded, 1 skipped.")
    ).toBeDefined()
    // never a merged "5 saved"
    expect(screen.queryByText(/5 of 6/)).toBeNull()
  })

  test("do not count as unsaved, so they are not offered for retry", () => {
    markSaved([1, 2, 3, 4, 5, 6, 7])
    markSaved([8, 9], "reused")

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 7, itemsReused: 2 })}
        {...handlers()}
      />
    )

    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull()
    expect(screen.queryByText(/not saved/i)).toBeNull()
  })

  test("offer download everything again, which drops the archive", () => {
    markSaved([1, 2, 3, 4, 5, 6, 7, 8, 9], "reused")
    const on = handlers()

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 0, itemsReused: 9 })}
        {...on}
      />
    )

    fireEvent.click(
      screen.getByRole("button", { name: en["playlist.downloadAgain"] })
    )

    expect(on.onRun).toHaveBeenCalledWith({ ignoreArchive: true })
  })

  test("and a run that reused nothing does not offer it", () => {
    markSaved([1, 2, 3, 4, 5, 6, 7, 8, 9])

    render(<PlaylistSummary state={finished()} {...handlers()} />)

    expect(
      screen.queryByRole("button", { name: en["playlist.downloadAgain"] })
    ).toBeNull()
  })
})

describe("the other two endings", () => {
  test("a failure says so, with the advice it came with", () => {
    render(
      <PlaylistSummary
        state={finished({
          status: "failed",
          itemsSaved: undefined,
          itemsTotal: undefined,
          error: "Cliply couldn't prepare its record of this download.",
          suggestion: "Check that Cliply can write to its app data folder."
        })}
        {...handlers()}
      />
    )

    expect(screen.getByText(en["playlist.failed"])).toBeDefined()
    expect(
      screen.getByText(/Check that Cliply can write to its app data folder/)
    ).toBeDefined()
  })

  test("a cancel keeps what it saved and says the next run resumes", () => {
    markSaved([1, 2, 3])

    render(
      <PlaylistSummary
        state={finished({
          status: "cancelled",
          itemsSaved: 3,
          itemsSkipped: 6
        })}
        {...handlers()}
      />
    )

    expect(screen.getByText("3 of 9 videos saved, 6 skipped.")).toBeDefined()
    expect(screen.getByText(/Videos already saved are kept/)).toBeDefined()
  })
})

describe("getting back to the list", () => {
  test("picking again is always available", () => {
    const on = handlers()
    render(<PlaylistSummary state={finished()} {...on} />)

    fireEvent.click(screen.getByRole("button", { name: en["playlist.pickAgain"] }))

    expect(on.onPickAgain).toHaveBeenCalled()
  })

  test("the copy uses no em-dash", () => {
    markSaved([1, 2])
    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 2, itemsReused: 1, itemsSkipped: 6 })}
        {...handlers()}
      />
    )

    expect(document.body.textContent).not.toContain("—")
  })
})

/**
 * about four installs in five run in russian, so this card is read in russian
 * far more often than in english. what has to survive the translation is the
 * sentence, not the words: the counts agree, the names are quoted the way
 * russian quotes them, and the retry button declines its own noun.
 */
describe("in russian", () => {
  afterEach(() => useLocale.getState().setLocale("en"))

  const inRussian = () => useLocale.getState().setLocale("ru")

  test("says what the run did, and names the one it missed", () => {
    markSaved([1, 2, 4, 5, 6, 7, 8, 9])
    inRussian()

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 8, itemsSkipped: 1 })}
        {...handlers()}
      />
    )

    expect(screen.getByText("сохранено 8 из 9 видео, пропущено 1.")).toBeDefined()
    // «» rather than "", which is the quote russian uses
    expect(
      screen.getByText(
        /не сохранено: «3 Things I Wish I Knew When I Was Broke»\./
      )
    ).toBeDefined()
    expect(screen.getByRole("button", { name: "открыть папку" })).toBeDefined()
    expect(
      screen.getByRole("button", { name: "повторить 1 загрузку" })
    ).toBeDefined()
    expect(
      screen.getByRole("button", { name: "выбрать видео заново" })
    ).toBeDefined()
  })

  test("counts the misses, declines the retry and joins the names with и", () => {
    markSaved([1, 2, 3, 4, 5])
    inRussian()

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 5, itemsSkipped: 4 })}
        {...handlers()}
      />
    )

    const line = screen.getByText(/не сохранено 4 видео:/)
    expect(line.textContent).toContain("«Small Habits, Big Outcomes»")
    expect(line.textContent).toContain("и ещё 1.")
    // four takes the `few` form, which english has no equivalent of
    expect(
      screen.getByRole("button", { name: "повторить 4 загрузки" })
    ).toBeDefined()
  })

  test("the archive line and the way out of it are russian too", () => {
    markSaved([1, 2, 3])
    markSaved([4, 5], "reused")
    inRussian()

    render(
      <PlaylistSummary
        state={finished({
          itemsSaved: 3,
          itemsReused: 2,
          itemsSkipped: 1,
          itemsTotal: 6
        })}
        {...handlers()}
      />
    )

    expect(
      screen.getByText("сохранено 3 из 6 видео, уже скачано 2, пропущено 1.")
    ).toBeDefined()
    expect(
      screen.getByRole("button", { name: "скачать всё заново" })
    ).toBeDefined()
  })

  test("and a cancel says what it kept", () => {
    inRussian()

    render(
      <PlaylistSummary
        state={finished({
          status: "cancelled",
          itemsSaved: undefined,
          itemsTotal: undefined
        })}
        {...handlers()}
      />
    )

    expect(screen.getByText("скачивание плейлиста отменено")).toBeDefined()
    expect(screen.getByText(/уже сохранённые видео остаются/)).toBeDefined()
  })

  /**
   * main writes its failures in english on purpose: the logs, the analytics
   * and the issue bodies carry that wording and maintainers read those. so
   * the swap happens here, against the taxonomy category the failure came
   * with, exactly as it does on the toast that said the same thing.
   */
  test("a failure main has a russian wording for is read in russian", () => {
    inRussian()

    render(
      <PlaylistSummary
        state={finished({
          status: "failed",
          itemsSaved: undefined,
          itemsTotal: undefined,
          error: "Cliply cannot write to the download folder.",
          suggestion: "Check permissions or choose another folder.",
          category: "PERMISSION_ERROR"
        })}
        {...handlers()}
      />
    )

    expect(screen.getByText("не удалось скачать плейлист")).toBeDefined()
    expect(
      screen.getByText(
        "не получается записать в папку загрузок. проверьте права доступа или выберите другую папку."
      )
    ).toBeDefined()
    expect(document.body.textContent).not.toContain("Cliply cannot write")
  })

  /**
   * the two permission failures a playlist can hit are the same category and
   * want opposite advice: one is the folder the user picked, the other is
   * cliply's own app data, and "choose another download folder" does nothing
   * about the second. main names that one, and the name is what gets read.
   */
  test("the archive refusal keeps its own diagnosis, not the category's", () => {
    inRussian()

    render(
      <PlaylistSummary
        state={finished({
          status: "failed",
          itemsSaved: undefined,
          itemsTotal: undefined,
          error: "Cliply couldn't prepare its record of this download.",
          suggestion:
            "Check permissions on Cliply's app data folder and try again.",
          category: "PERMISSION_ERROR",
          wordingCode: "RECORDS_UNWRITABLE"
        })}
        {...handlers()}
      />
    )

    expect(
      screen.getByText(
        "cliply не смог подготовить запись об этой загрузке. проверьте права доступа к папке с данными cliply и попробуйте снова."
      )
    ).toBeDefined()
    // the advice that cannot fix this one, and would have been given here
    expect(document.body.textContent).not.toContain("выберите другую папку")
  })

  // and an english reader gets main's own wording for both of them, which is
  // the sentence the logs and the issue body will carry
  test.each([
    [
      "the download folder",
      undefined,
      "Cliply cannot write to the download folder.",
      "Check permissions or choose another folder."
    ],
    [
      "cliply's own records",
      "RECORDS_UNWRITABLE",
      "Cliply couldn't prepare its record of this download.",
      "Check permissions on Cliply's app data folder and try again."
    ]
  ])(
    "and english passes through untouched for %s",
    (_name, wordingCode, error, suggestion) => {
      render(
        <PlaylistSummary
          state={finished({
            status: "failed",
            itemsSaved: undefined,
            itemsTotal: undefined,
            error,
            suggestion,
            category: "PERMISSION_ERROR",
            wordingCode
          })}
          {...handlers()}
        />
      )

      expect(screen.getByText(`${error} ${suggestion}`)).toBeDefined()
    }
  )

  /**
   * and a category this dictionary has not caught up with keeps main's own
   * sentence, which is the right failure mode: english a reader can paste
   * into a search box beats a blank line.
   */
  test("and one it does not falls through to main's english", () => {
    inRussian()

    render(
      <PlaylistSummary
        state={finished({
          status: "failed",
          itemsSaved: undefined,
          itemsTotal: undefined,
          error: "Something main learned to say this week.",
          suggestion: "Try it again.",
          category: "SOMETHING_NEW"
        })}
        {...handlers()}
      />
    )

    // the title is ours, so it is translated either way
    expect(screen.getByText("не удалось скачать плейлист")).toBeDefined()
    expect(
      screen.getByText("Something main learned to say this week. Try it again.")
    ).toBeDefined()
  })

  test("and none of it in an em-dash", () => {
    markSaved([1, 2])
    inRussian()

    render(
      <PlaylistSummary
        state={finished({ itemsSaved: 2, itemsReused: 1, itemsSkipped: 6 })}
        {...handlers()}
      />
    )

    expect(document.body.textContent).not.toContain("—")
  })
})

/**
 * the same reasoning that makes a partial run a normal outcome makes it a
 * plain card: the app is slate with a cyan accent, red is for validation and
 * for the cancel hover, and nothing in it is ever green. a green card over
 * eight of nine and a red one under a failure are both verdicts this card has
 * no business handing down, so every ending lands on the card the picker and
 * the progress screen already use.
 *
 * asserted on the rendered classes rather than on a prop, because the emerald
 * and red cards this replaced were a ternary the card still would have had.
 */
describe("the palette an ending is allowed to use", () => {
  const OFF_PALETTE = /\b(bg|text|border)-(red|green|emerald|rose|sky)-\d+/

  test("is slate and cyan, however the run ended", () => {
    const endings: Partial<PlaylistDownloadState>[] = [
      { status: "completed", itemsSaved: 9 },
      { status: "completed", itemsSaved: 8, itemsSkipped: 1 },
      {
        status: "failed",
        itemsSaved: undefined,
        itemsTotal: undefined,
        error: "Cliply couldn't prepare its record of this download.",
        suggestion: "Check that Cliply can write to its app data folder."
      },
      { status: "cancelled", itemsSaved: 3, itemsSkipped: 6 }
    ]

    for (const ending of endings) {
      cleanup()
      markSaved([1, 2, 3])
      render(<PlaylistSummary state={finished(ending)} {...handlers()} />)

      expect(document.body.innerHTML).not.toMatch(OFF_PALETTE)
    }
  })

  test("and a failure is not drawn as a different card from a success", () => {
    const card = () =>
      (document.querySelector(".rounded-2xl") as HTMLElement).className

    render(<PlaylistSummary state={finished()} {...handlers()} />)
    const completed = card()

    cleanup()
    render(
      <PlaylistSummary
        state={finished({ status: "failed", error: "It fell over." })}
        {...handlers()}
      />
    )

    expect(card()).toBe(completed)
  })
})
