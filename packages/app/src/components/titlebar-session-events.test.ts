import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import {
  readSessionTabSelectedDetail,
  readSessionTabsRemovedDetail,
  SESSION_TAB_SELECTED_EVENT,
  SESSION_TABS_REMOVED_EVENT,
} from "./titlebar-session-events"

const remote = "remote" as ServerConnection.Key

describe("titlebar session events", () => {
  test("reads valid removed session tab details", () => {
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { server: "remote", directory: "/tmp/project", sessionIDs: ["ses_1", "ses_2", 1] },
        }),
      ),
    ).toEqual({
      server: remote,
      directory: "/tmp/project",
      sessionIDs: ["ses_1", "ses_2"],
    })
  })

  test("ignores invalid removed session tab details", () => {
    expect(readSessionTabsRemovedDetail(new Event(SESSION_TABS_REMOVED_EVENT))).toBeUndefined()
    expect(
      readSessionTabsRemovedDetail(
        new CustomEvent(SESSION_TABS_REMOVED_EVENT, {
          detail: { directory: "/tmp/project", sessionIDs: [] },
        }),
      ),
    ).toBeUndefined()
  })

  test("reads valid selected session tab details", () => {
    expect(
      readSessionTabSelectedDetail(
        new CustomEvent(SESSION_TAB_SELECTED_EVENT, {
          detail: { server: "remote", sessionID: "ses_1" },
        }),
      ),
    ).toEqual({
      server: remote,
      sessionID: "ses_1",
    })
  })

  test("ignores invalid selected session tab details", () => {
    expect(readSessionTabSelectedDetail(new Event(SESSION_TAB_SELECTED_EVENT))).toBeUndefined()
    expect(
      readSessionTabSelectedDetail(
        new CustomEvent(SESSION_TAB_SELECTED_EVENT, {
          detail: { server: "remote" },
        }),
      ),
    ).toBeUndefined()
    expect(
      readSessionTabSelectedDetail(
        new CustomEvent(SESSION_TAB_SELECTED_EVENT, {
          detail: { server: "remote", sessionID: 1 },
        }),
      ),
    ).toBeUndefined()
  })
})
