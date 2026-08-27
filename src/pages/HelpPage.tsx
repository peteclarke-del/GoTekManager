/**
 * In-app help.
 *
 * Kept deliberately honest: it describes what the application does today and
 * names what it cannot do, so nobody plans a session around a capability that
 * is not implemented.
 *
 * The screenshots are captured from the running application by
 * `npm run screenshots`, which drives the real interface against fixture
 * folders. Re-run it whenever a screen changes, so the images cannot quietly
 * drift out of date the way hand-taken ones do.
 */

import type { ReactNode } from 'react'
import type { ThemeChoice } from '../domain/types'
import { useResolvedTheme } from '../hooks/useResolvedTheme'
import { FLOW_SCREENS, PROFILES_SCREEN } from './helpScreens'

const GUIDES: Array<{ question: string; answer: ReactNode }> = [
  {
    question: 'Why must I assign some platforms?',
    answer: (
      <>
        Extensions such as <code>.dsk</code> and <code>.img</code> are shared by several
        machines. GoTek Manager records the likely matches but asks for an explicit
        choice before an ambiguous title joins a profile, so a plan is never a guess.
      </>
    ),
  },
  {
    question: 'Why is a format I have not listed?',
    answer: (
      <>
        A GoTek emulates a <b>floppy drive</b>, so it can only present floppy disk
        images. Tape images (<code>.tap</code>, <code>.tzx</code>, <code>.uef</code>),
        programs and cartridges (<code>.prg</code>, <code>.crt</code>,{' '}
        <code>.nex</code>), and flux or copy-protection formats (<code>.ipf</code>,{' '}
        <code>.atx</code>) cannot be loaded by any GoTek firmware. Commodore{' '}
        <code>.d64</code> and <code>.d71</code> are GCR recordings from the 1541 and
        1571, which a GoTek cannot reproduce; the 1581 uses ordinary MFM disks, so{' '}
        <code>.d81</code> works.
      </>
    ),
  },
  {
    question: 'How does firmware compatibility work?',
    answer: (
      <>
        Support depends on both the machine and the firmware, so the accepted list is
        the overlap of the two. FlashFloppy reads Atari 8-bit <code>.atr</code>{' '}
        directly, for example, while HxC does not. Formats outside the overlap, such as{' '}
        <code>.msa</code>, <code>.scl</code>, and <code>.d64</code>, must be converted
        to <code>.hfe</code> on a computer first. These mappings guide planning; check
        them against your exact drive, host interface, firmware version, and
        configuration.
      </>
    ),
  },
  {
    question: 'What do the layout and naming options do?',
    answer: (
      <>
        The platform layout writes into short per-platform folders. OLED naming removes
        common release labels and trims the filename to the firmware's display width.
        The library always keeps the canonical name, and source files are never renamed
        or moved.
      </>
    ),
  },
  {
    question: 'What can be written today?',
    answer: (
      <>
        Verified copies into a folder or a mounted volume. Nothing is ever overwritten:
        a destination path that already holds different content becomes a conflict and
        blocks the plan. Formatting, partitioning, raw image writes, and creating or
        converting image files are <b>not</b> implemented.
      </>
    ),
  },
  {
    question: 'How is a write kept safe?',
    answer: (
      <>
        The plan is rebuilt from the destination immediately before writing, so media
        swapped after you pressed Confirm cannot be written with stale expectations.
        Each file is copied to a temporary name, flushed to the device, size-checked,
        and only then put in place. System locations are refused outright.
      </>
    ),
  },
  {
    question: 'What is the difference between Keep and Remove?',
    answer: (
      <>
        <b>Keep</b> leaves everything already on the destination alone. <b>Remove</b>{' '}
        deletes only files in the formats this drive can actually load that the
        collection does not contain; anything else, including firmware configuration
        files, stays and is flagged as a profile mismatch.
      </>
    ),
  },
  {
    question: 'What about USB filesystem images and online archives?',
    answer: (
      <>
        FAT <code>.img</code> and <code>.ima</code> images can be browsed read-only
        without mounting them. Online sources can search the Internet Archive, inspect
        permitted sites, or read structured catalogue feeds. Downloads are cached with
        their source and licence, and a ZIP bundle contributes each supported image
        separately.
      </>
    ),
  },
  {
    question: 'How are missing titles identified?',
    answer: (
      <>
        Cached catalogues for the selected platform are compared with local titles after
        removing common release and disk labels. Present and Missing are advisory: check
        alternate names, compilations, and regional releases before treating the totals
        as definitive.
      </>
    ),
  },
  {
    question: 'Why are some online sites unavailable?',
    answer: (
      <>
        GoTek Manager follows each site's access policy and will not bypass robots
        rules, authentication, payment, licensing, or blocked download routes. Sites
        that disallow inspection need an approved API or export instead, which can still
        be added as a JSON reference list.
      </>
    ),
  },
]

function Screenshot({
  theme,
  name,
  title,
  caption,
}: {
  theme: 'light' | 'dark'
  name: string
  title: string
  caption: string
}) {
  return (
    <figure>
      <img src={`/help/${theme}/${name}.png`} alt={`The ${title} screen`} loading="lazy" />
      <figcaption>
        <b>{title}</b>
        <span>{caption}</span>
      </figcaption>
    </figure>
  )
}

export function HelpPage({ theme }: { theme: ThemeChoice }) {
  // The screenshots exist in both palettes; show the one on screen.
  const resolved = useResolvedTheme(theme)

  return (
    <div className="help">
      <section className="panel">
        <h2>One guided flow</h2>
        <p>
          Choose a profile, review the destination, add files from local or online
          sources, verify the before and after state, confirm the write, and read the
          result. Source files are never renamed or moved.
        </p>
        <ol className="flow-help">
          {FLOW_SCREENS.map((screen) => (
            <li key={screen.name}>
              <b>{screen.title}</b>
              <span>{screen.detail}</span>
            </li>
          ))}
        </ol>
        <div className="help-shots">
          {FLOW_SCREENS.map((screen, index) => (
            <Screenshot
              key={screen.name}
              theme={resolved}
              name={screen.name}
              title={`${index + 1} · ${screen.title}`}
              caption={screen.detail}
            />
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Managing profiles</h2>
        <p>
          A profile pairs one destination with the platform, firmware, layout, and
          naming rules used to write to it. The profiles screen creates them, edits
          them, and re-checks each destination when you select it, so a volume that has
          been unplugged or has become read-only is reported here rather than halfway
          through a write.
        </p>
        <div className="help-shots">
          <Screenshot
            theme={resolved}
            name={PROFILES_SCREEN.name}
            title={PROFILES_SCREEN.title}
            caption={PROFILES_SCREEN.detail}
          />
        </div>
      </section>

      <section className="panel">
        <h2>Guides</h2>
        {GUIDES.map((guide, index) => (
          <details key={guide.question} open={index === 0}>
            <summary>{guide.question}</summary>
            <p>{guide.answer}</p>
          </details>
        ))}
      </section>
    </div>
  )
}
