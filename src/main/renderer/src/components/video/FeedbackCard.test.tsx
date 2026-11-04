// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { systemApi } from "@/lib/api"
import { useLocale } from "@/lib/i18n"
import { FeedbackCard } from "./FeedbackCard"

vi.mock("@/lib/api", () => ({ systemApi: { openExternal: vi.fn() } }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useLocale.setState({ locale: "en" })
})

test.each([
  ["en", "join discord", "send feedback"],
  ["ru", "в discord", "оставить отзыв"]
] as const)("%s offers Discord and keeps direct feedback through the browser bridge", (locale, join, feedback) => {
  useLocale.setState({ locale })
  render(<FeedbackCard />)

  fireEvent.click(screen.getByRole("link", { name: join }))
  expect(systemApi.openExternal).toHaveBeenLastCalledWith("https://discord.gg/kjhtgYFFbh")
  fireEvent.click(screen.getByRole("link", { name: feedback }))
  expect(systemApi.openExternal).toHaveBeenLastCalledWith("https://cliply.space/hey")
})
