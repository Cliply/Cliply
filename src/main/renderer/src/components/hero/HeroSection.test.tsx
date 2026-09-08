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
// renders the labels rather than a blank div: a test asserting an item is
// absent is worthless against a mock that never rendered any item at all
vi.mock("@/components/ui/menu-vertical", () => ({
  MenuVertical: ({
    menuItems
  }: {
    menuItems: { label: string; href?: string }[]
  }) => (
    <div>
      {menuItems.map((item) => (
        <span key={item.label} data-testid="menu-item" data-href={item.href}>
          {item.label}
        </span>
      ))}
    </div>
  )
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

// the passive donate ask. it never interrupts, so the only thing that can go
// wrong is it quietly disappearing in a refactor and nobody noticing
describe("the donate line", () => {
  test("says who is on the other end, and links out", async () => {
    const { HeroSection } = await import("./HeroSection")
    render(<HeroSection />)

    // two lines: the reason, then the ask
    expect(
      screen.getByText(/one person makes it and keeps it running/i)
    ).toBeTruthy()
    expect(screen.getByText(/if it's been useful/i)).toBeTruthy()

    const link = screen.getByText("buy me a coffee")
    expect(link.getAttribute("href")).toBe("https://buymeacoffee.com/itssdevk")
  })
})

// navigation is one column now. github and disclaimer used to sit in a row
// along the bottom edge, which put four links in two opposite corners
describe("the menu", () => {
  test("carries all four, in order", async () => {
    const { HeroSection } = await import("./HeroSection")
    render(<HeroSection />)

    expect(
      screen.getAllByTestId("menu-item").map((node) => node.textContent)
    ).toEqual(["about", "update", "donate", "github"])
  })

  // two doors to the same room made the menu longer for nothing, once the line
  // in the top chrome started offering it to people who would never go looking
  test("no longer carries its own cookies entry", async () => {
    const { HeroSection } = await import("./HeroSection")
    render(<HeroSection />)

    expect(screen.queryByText("cookies")).toBeNull()
  })

  test("github and about point where they say", async () => {
    const { HeroSection } = await import("./HeroSection")
    render(<HeroSection />)

    const hrefs = Object.fromEntries(
      screen
        .getAllByTestId("menu-item")
        .map((node) => [node.textContent, node.getAttribute("data-href")])
    )

    expect(hrefs.github).toBe("https://github.com/Cliply/Cliply/")
    // the label changed, the route did not
    expect(hrefs.about).toBe("/disclaimer")
  })
})
