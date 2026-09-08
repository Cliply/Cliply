// @vitest-environment jsdom
//
// the one place the cookie dialog is offered before anything has gone wrong
//
// the other two routes both need a failure first: the menu item, which you have
// to go looking for, and the toast on a blocked download. This line sits in the
// chrome and is the only pre-emptive one, so it is worth a test that it still
// opens the thing it advertises.

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { useCookieStore } from "@/lib/cookieStore"

vi.mock("@/lib/api", () => ({
  updaterApi: { checkForUpdates: vi.fn() },
  systemApi: { openExternal: vi.fn() }
}))
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() })
}))
// the hero pulls in the whole search stack, none of which this is about
vi.mock("./SearchCard", () => ({ SearchCard: () => <div /> }))
vi.mock("@/components/ui/menu-vertical", () => ({
  MenuVertical: () => <div />
}))
vi.mock("@/components/ui/mode-toggle", () => ({ ModeToggle: () => <div /> }))
vi.mock("react-router-dom", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>
}))

beforeEach(() => {
  useCookieStore.setState({ isOpen: false })
})

afterEach(cleanup)

describe("the line in the top chrome", () => {
  test("names the problem the user actually has", async () => {
    const { HeroSection } = await import("./HeroSection")
    render(<HeroSection />)

    expect(screen.getByText(/having trouble with downloads/i)).toBeTruthy()
  })

  test("opens the cookie dialog rather than a browser", async () => {
    const { HeroSection } = await import("./HeroSection")
    render(<HeroSection />)

    expect(useCookieStore.getState().isOpen).toBe(false)
    screen.getByText(/having trouble with downloads/i).click()

    expect(useCookieStore.getState().isOpen).toBe(true)
  })
})
