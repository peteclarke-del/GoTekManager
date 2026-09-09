/**
 * The latest payload of a native event, or nothing.
 *
 * Every progress indicator in the application wants the same three things: to
 * listen while it is on screen, to stop listening when it leaves, and to clear
 * itself once the work it describes is over. Doing that correctly means
 * handling an unlisten that arrives after the component has already gone, which
 * is easy to get subtly wrong twice over, so it is written once here.
 */

import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { isDesktop } from '../native/commands'

export function useNativeEvent<T>(
  event: string,
  /** What to keep from a payload. Returning `null` clears the indicator. */
  keep: (payload: T) => T | null,
): T | null {
  const [value, setValue] = useState<T | null>(null)

  useEffect(() => {
    if (!isDesktop()) return
    let stop: (() => void) | undefined
    let active = true
    void listen<T>(event, (message) => setValue(keep(message.payload))).then((unlisten) => {
      // The subscription can arrive after the component has gone, in which
      // case it is cancelled rather than left running against dead state.
      if (active) stop = unlisten
      else unlisten()
    })
    return () => {
      active = false
      stop?.()
    }
    // `keep` is a rule about the payload rather than state, so re-subscribing
    // when its identity changes would drop events for no reason.
  }, [event])

  return value
}
