import { describe, expect, test } from "bun:test"
import {
  canOpenTabRename,
  canStartTabDrag,
  forwardTabRef,
  isTabCloseTarget,
  suppressNextMiddleAuxClick,
} from "./titlebar-tab-gesture"

describe("titlebar tab gestures", () => {
  test("excludes close controls from tab gestures", () => {
    const close = document.createElement("div")
    const button = document.createElement("button")
    const link = document.createElement("a")
    close.dataset.slot = "tab-close"
    close.append(button)
    expect(isTabCloseTarget(close)).toBe(true)
    expect(isTabCloseTarget(button)).toBe(true)
    expect(isTabCloseTarget(link)).toBe(false)
  })

  test("forwards component refs", () => {
    const element = document.createElement("div")
    let received: HTMLDivElement | undefined
    forwardTabRef((value) => (received = value), element)
    expect(received).toBe(element)
  })

  test("suppresses the auxclick following a middle-click close", () => {
    const link = document.createElement("a")
    let reachedLink = false
    document.body.append(link)
    link.addEventListener("auxclick", () => (reachedLink = true))

    suppressNextMiddleAuxClick(document)
    const event = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })
    const dispatched = link.dispatchEvent(event)

    expect(dispatched).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(reachedLink).toBe(false)
    link.remove()
  })

  test("does not reopen rename while a save is pending", () => {
    expect(canOpenTabRename(false, false, false)).toBe(true)
    expect(canOpenTabRename(false, false, true)).toBe(false)
  })

  test("preserves native panning for touch pointers", () => {
    expect(canStartTabDrag("mouse")).toBe(true)
    expect(canStartTabDrag("pen")).toBe(true)
    expect(canStartTabDrag("touch")).toBe(false)
  })
})
