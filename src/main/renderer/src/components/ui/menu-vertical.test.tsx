// @vitest-environment jsdom
//
// the three branches of a menu item have to lay out identically
//
// they did not. The variants translate a label by -20 so it sits under the
// hidden arrow, and a transform does nothing to a non-replaced inline element.
// An external link and a plain button are flex items, so they get blockified
// and move; an internal route is wrapped in a Link, stays inline, and sat 20px
// to the right of everything else - which is exactly what the menu looked like
// once github and disclaimer moved into it.
//
// jsdom applies no tailwind and does not blockify flex items, so the computed
// display is worth nothing here. What can be checked is that the label inside
// the Link still carries the class that makes the transform apply at all.

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { MenuVertical } from "./menu-vertical"

vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a data-testid="router-link" href={to}>
      {children}
    </a>
  )
}))

afterEach(cleanup)

const ITEMS = [
  { label: "update", onClick: () => {} },
  { label: "donate", href: "https://example.com", external: true },
  { label: "disclaimer", href: "/disclaimer" }
]

describe("every item, however it navigates", () => {
  // the regression in one assertion: the wrapped label must not be left inline
  test("an internal route's label is not left as a plain inline span", () => {
    render(<MenuVertical menuItems={ITEMS} color="#0891b2" skew={-2} />)

    const inside = screen.getByTestId("router-link").firstElementChild

    expect(inside?.className).toContain("inline-block")
  })
})
