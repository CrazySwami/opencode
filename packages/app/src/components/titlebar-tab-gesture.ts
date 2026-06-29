import type { Ref } from "solid-js"

export function isTabCloseTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('[data-slot="tab-close"]')
}

export function canStartTabDrag(pointerType: string) {
  return pointerType !== "touch"
}

let cancelMiddleAuxClick: (() => void) | undefined

export function suppressNextMiddleAuxClick(doc: Document = document) {
  // Closing on mousedown can move another tab link under the pointer before auxclick fires.
  // Catch that one follow-up event at the document level so Electron does not open it in a new window.
  cancelMiddleAuxClick?.()

  const controller = new AbortController()
  const win = doc.defaultView ?? window
  let timeout: number | undefined

  const cleanup = () => {
    if (timeout !== undefined) win.clearTimeout(timeout)
    controller.abort()
    if (cancelMiddleAuxClick === cleanup) cancelMiddleAuxClick = undefined
  }

  const suppress = (event: MouseEvent) => {
    if (event.button !== 1) return
    event.preventDefault()
    event.stopPropagation()
    cleanup()
  }

  timeout = win.setTimeout(cleanup, 1000)
  cancelMiddleAuxClick = cleanup
  doc.addEventListener("auxclick", suppress, { capture: true, signal: controller.signal })
}

export function forwardTabRef(ref: Ref<HTMLDivElement> | undefined, element: HTMLDivElement) {
  if (typeof ref === "function") ref(element)
}

export function canOpenTabRename(dragging: boolean | undefined, editing: boolean, committing: boolean) {
  return !dragging && !editing && !committing
}
