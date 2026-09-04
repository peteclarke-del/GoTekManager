/**
 * Roughly how many characters the title column can show.
 *
 * The column is a share of a panel that is a share of the window, and columns
 * beside it drop away at set widths, so what fits changes as the window does.
 * Measuring every cell would mean an observer per row; the window's own width
 * says the same thing for the price of one listener, and the answer only has to
 * be close — what it decides is where a name is elided, not whether it is
 * readable, since the full name is always a hover away.
 *
 * The numbers come from measuring the rendered column at each width and
 * dividing by the width of a character in the table's font.
 */

import { useEffect, useState } from 'react'

const STEPS: Array<[number, number]> = [
  [1500, 43],
  [1400, 38],
  [1250, 34],
  [1050, 30],
  [0, 22],
]

function roomFor(width: number): number {
  return STEPS.find(([from]) => width >= from)?.[1] ?? 22
}

export function useTitleRoom(): number {
  const [room, setRoom] = useState(() =>
    roomFor(typeof window === 'undefined' ? 1280 : window.innerWidth),
  )

  useEffect(() => {
    const measure = () => setRoom(roomFor(window.innerWidth))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  return room
}
