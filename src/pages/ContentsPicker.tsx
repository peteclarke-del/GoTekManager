/**
 * Choosing what to leave off a stick, for one write only.
 *
 * A collection rarely fits on the media it is going to, so this is where the
 * difference is settled: the profile's destination as a folder tree, a tick
 * against everything, and a running total that says how much of the stick the
 * ticked things would take.
 *
 * Nothing here touches the master. Unticking a title leaves it out of *this*
 * write and nothing else; the folder it came from is not altered, and the next
 * write starts from everything again.
 */

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Wand2, X } from 'lucide-react'
import { Modal } from '../components/Modal'
import { InlineStatus } from '../components/Feedback'
import { formatBytes } from '../domain/media'
import {
  costOf,
  isExcluded,
  keptFiles,
  proposeExclusions,
  treeOf,
  type Capacity,
  type HeldFile,
  type TreeNode,
} from '../domain/deviceBuild'
import type { Profile } from '../domain/types'

/** Whether a folder's contents are all in, all out, or a mixture. */
function coverageOf(node: TreeNode, excluded: ReadonlySet<string>): 'in' | 'out' | 'some' {
  if (isExcluded(node.path, excluded)) return 'out'
  if (!node.directory) return 'in'
  const states = new Set(node.children.map((child) => coverageOf(child, excluded)))
  if (states.size === 1) return [...states][0]
  return states.size ? 'some' : 'in'
}

/** How many children of one folder are drawn before asking. */
const PER_FOLDER = 100

function Row({
  node,
  depth,
  excluded,
  toggle,
}: {
  node: TreeNode
  depth: number
  excluded: ReadonlySet<string>
  toggle: (path: string, on: boolean) => void
}) {
  // Closed to begin with. A destination of ten thousand titles drawn in full is
  // a few hundred thousand elements of markup and a dialog that never appears;
  // closed, the top level is the handful of category folders, which is the
  // level the decision is actually made at.
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(PER_FOLDER)
  const state = coverageOf(node, excluded)

  return (
    <>
      <div className="picker-row">
        <input
          type="checkbox"
          checked={state !== 'out'}
          ref={(box) => {
            if (box) box.indeterminate = state === 'some'
          }}
          aria-label={`Include ${node.name}`}
          onChange={(event) => toggle(node.path, event.target.checked)}
        />
        {node.directory ? (
          <button
            className="picker-name"
            style={{ paddingLeft: `${depth * 16}px` }}
            aria-expanded={open}
            title={node.path}
            onClick={() => setOpen((shown) => !shown)}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
            <b>{node.name}</b>
            <small>
              {node.files.toLocaleString()} file{node.files === 1 ? '' : 's'}
            </small>
          </button>
        ) : (
          <span
            className="picker-name file"
            style={{ paddingLeft: `${depth * 16 + 18}px` }}
            title={node.path}
          >
            {node.name}
          </span>
        )}
        <span className="picker-size">{formatBytes(node.size)}</span>
      </div>
      {node.directory &&
        open &&
        node.children
          .slice(0, shown)
          .map((child) => (
            <Row
              key={child.path}
              node={child}
              depth={depth + 1}
              excluded={excluded}
              toggle={toggle}
            />
          ))}
      {node.directory && open && node.children.length > shown && (
        <div className="picker-row picker-more">
          <span />
          <button
            className="link-button"
            style={{ marginLeft: `${(depth + 1) * 16}px` }}
            onClick={() => setShown((count) => count + PER_FOLDER)}
          >
            Show {Math.min(PER_FOLDER, node.children.length - shown).toLocaleString()} more of{' '}
            {node.children.length.toLocaleString()}
          </button>
          <span />
        </div>
      )}
    </>
  )
}

export function ContentsPicker({
  profile,
  files,
  capacity,
  initial,
  close,
  confirm,
}: {
  profile: Profile
  files: HeldFile[]
  capacity: Capacity
  /** Where to start: empty for a manual choice, or the automatic proposal. */
  initial: { excluded: Set<string>; steps: string[] }
  close: () => void
  confirm: (kept: HeldFile[]) => void
}) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set(initial.excluded))
  const [steps, setSteps] = useState<string[]>(initial.steps)

  const tree = useMemo(() => treeOf(files), [files])
  const kept = useMemo(() => keptFiles(files, excluded), [files, excluded])
  const needed = useMemo(() => costOf(kept, capacity.clusterBytes), [kept, capacity])
  const over = needed - capacity.usableBytes
  const fits = over <= 0

  const toggle = (path: string, on: boolean) => {
    setSteps([])
    setExcluded((current) => {
      const next = new Set(current)
      if (on) {
        // Putting a folder back also puts back anything below it that was
        // taken out separately, which is what ticking a folder means.
        next.delete(path)
        for (const entry of [...next]) {
          if (entry.startsWith(`${path}/`)) next.delete(entry)
        }
      } else {
        next.add(path)
      }
      return next
    })
  }

  const propose = () => {
    const proposal = proposeExclusions(files, profile, capacity)
    setExcluded(proposal.excluded)
    setSteps(
      proposal.fits
        ? proposal.steps
        : [...proposal.steps, 'Even after all of that it does not fit.'],
    )
  }

  return (
    <Modal title={`What to write to this stick`} onClose={close} className="picker-modal">
      <div className="picker">
        <p className="picker-total">
          <b className={fits ? 'fits' : 'over'}>
            {formatBytes(needed)} of {formatBytes(capacity.usableBytes)}
          </b>{' '}
          · {kept.length.toLocaleString()} file{kept.length === 1 ? '' : 's'}
          {fits ? <> · {formatBytes(-over)} to spare</> : <> · {formatBytes(over)} too much</>}
        </p>

        {steps.length > 0 && (
          <InlineStatus kind={fits ? 'info' : 'error'}>
            <b>Chosen for you, and every one can be put back:</b>
            <ul className="picker-steps">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          </InlineStatus>
        )}

        <div className="picker-tree">
          {tree.map((node) => (
            <Row key={node.path} node={node} depth={0} excluded={excluded} toggle={toggle} />
          ))}
        </div>

        <div className="picker-actions">
          <button className="button secondary compact" onClick={propose}>
            <Wand2 />
            Choose for me
          </button>
          <button
            className="button secondary compact"
            disabled={!excluded.size}
            onClick={() => {
              setExcluded(new Set())
              setSteps([])
            }}
          >
            <X />
            Put everything back
          </button>
          <button
            className="button"
            disabled={!fits || !kept.length}
            title={fits ? undefined : 'Leave more out until it fits'}
            onClick={() => confirm(kept)}
          >
            Use these {kept.length.toLocaleString()} files
          </button>
        </div>
        <p className="mode-note">
          This only decides what goes on the stick. The profile's own folder is not changed, and
          the next write starts from everything again.
        </p>
      </div>
    </Modal>
  )
}
