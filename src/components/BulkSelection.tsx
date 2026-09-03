/**
 * The controls a multi-selection table is made of: the tick box in each row,
 * the one in the header that covers the lot, and the bar of actions that
 * appears once something is ticked.
 *
 * They are shared rather than repeated so that ticking rows means the same
 * thing, and reads the same way to a screen reader, in every pane that lists
 * disk images.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { RowSelection } from '../hooks/useRowSelection'

/**
 * A tick box that can also show the half-ticked state.
 *
 * `indeterminate` is not an attribute, only a property, so it has to be set on
 * the element itself after every render.
 */
function TickBox({
  checked,
  indeterminate = false,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  label: string
  /** Told whether the click was a shift-click, which extends a run. */
  onChange: (extend: boolean) => void
}) {
  const box = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (box.current) box.current.indeterminate = indeterminate && !checked
  }, [indeterminate, checked])

  return (
    <input
      ref={box}
      type="checkbox"
      className="tick-box"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => onChange(Boolean((event.nativeEvent as MouseEvent).shiftKey))}
    />
  )
}

/**
 * The column definition for the tick column.
 *
 * A width on the cell alone is not enough: these tables lay out with
 * `table-layout: fixed`, where Chromium treats a cell width as a hint and hands
 * the column a share of whatever space is left over, pushing the real columns
 * aside. A `<col>` is the mechanism the layout is actually defined in terms of,
 * so the tick column keeps its box and the spare space goes where it belongs.
 *
 * Only the first column is described. Listing the rest as bare `<col>` elements
 * looks harmless but changes how WebKit shares out the remaining width, which
 * pushed the last column of the destination listing off the edge.
 */
export function SelectColumns() {
  return (
    <colgroup>
      <col className="select-col" />
    </colgroup>
  )
}

/** The header cell that ticks or clears every row on screen. */
export function SelectAllCell({
  selection,
  label = 'Select every row shown',
}: {
  selection: RowSelection
  label?: string
}) {
  return (
    <th className="select-cell">
      <TickBox
        checked={selection.coverage === 'all'}
        indeterminate={selection.coverage === 'some'}
        disabled={!selection.total}
        label={label}
        onChange={selection.toggleAll}
      />
    </th>
  )
}

/** One row's tick box, for a list that is not laid out as a table. */
export function SelectBox({
  selection,
  id,
  label,
  disabled = false,
}: {
  selection: RowSelection
  id: string
  label: string
  disabled?: boolean
}) {
  return (
    <TickBox
      checked={selection.isSelected(id)}
      disabled={disabled}
      label={label}
      onChange={(extend) => selection.toggle(id, extend)}
    />
  )
}

/**
 * One row's tick box, as a table cell.
 *
 * A row that cannot take part — an online entry with nothing to download, say —
 * still gets a cell, so the columns stay aligned, with the reason on the box.
 */
export function SelectCell({
  selection,
  id,
  label,
  disabled = false,
  reason,
}: {
  selection: RowSelection
  id: string
  label: string
  disabled?: boolean
  reason?: string
}) {
  return (
    <td className="select-cell" title={disabled ? reason : 'Shift-click to select a run'}>
      <SelectBox selection={selection} id={id} label={label} disabled={disabled} />
    </td>
  )
}

/**
 * The actions for what is ticked.
 *
 * Hidden entirely while nothing is, because a bar of disabled buttons above
 * every table is noise rather than help.
 */
export function BulkBar({
  selection,
  noun,
  children,
}: {
  selection: RowSelection
  /** What the rows are, plural: "titles", "files". */
  noun: string
  children: ReactNode
}) {
  if (!selection.count) return null

  return (
    <div className="bulk-bar" role="group" aria-label={`Actions for the selected ${noun}`}>
      <b>
        {selection.count} of {selection.total} {noun} selected
      </b>
      <div className="bulk-actions">{children}</div>
      <button className="button secondary compact" onClick={selection.clear}>
        <X />
        Clear selection
      </button>
    </div>
  )
}
