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
        The platform layout writes into short per-platform folders, and the category
        layout into <code>Games</code>, <code>Apps</code>, <code>Demos</code> and the
        rest, with <code>Unsorted</code> for titles nobody has filed. A custom layout
        combines them, as in <code>{'{platform}/{category}'}</code>. OLED naming removes
        common release labels and trims the filename to the firmware's display width.
        The library always keeps the canonical name, and source files are never renamed
        or moved.
      </>
    ),
  },
  {
    question: 'Where do categories come from?',
    answer: (
      <>
        From the folders a collection already uses: a title under{' '}
        <code>Applications</code> or <code>Games [ADF]</code> is read as one, deepest
        folder first, and anything unrecognised is left unset rather than guessed at.
        Set the rest in the library table, several at a time with the tick boxes.
      </>
    ),
  },
  {
    question: 'My drive\u2019s display is upside down. Can that be fixed?',
    answer: (
      <>
        Yes, if it runs FlashFloppy. A profile names the panel fitted to its drive, and
        the rotated choices write <code>display-type=oled-128x64-rotate</code> (or
        128x32) into <code>FF.CFG</code>, which turns the view 180 degrees. Rotation can
        only be asked for on a named panel, which is why the size is chosen rather than
        detected. A configuration already on the drive is updated rather than replaced:
        only the settings this application is responsible for change, and everything
        else in the file is kept.
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
        without mounting them. A ZIP in a library is listed rather than unpacked: each
        supported image inside it becomes a title, read out of the archive only when it
        is written, so a folder of thousands of archives is indexed in seconds. Online
        sources can search the Internet Archive, inspect permitted sites, or read
        structured catalogue feeds; downloads are cached with their source and licence,
        and a downloaded ZIP contributes each supported image separately.
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
        Every source that ships with GoTek Manager obeys the site's <code>robots.txt</code>,
        identifies itself honestly, and never bypasses authentication, payment, or
        licensing. Sites that disallow inspection are better served by an approved API
        or export, which can be added as a JSON reference list.
      </>
    ),
  },
  {
    question: 'Can I scan a site that asks not to be scanned?',
    answer: (
      <>
        You can, per source, and you are told what it means before you do. A{' '}
        <code>robots.txt</code> is the operator stating a preference, and overriding it
        may breach their terms, may get your address blocked, and on a storefront may
        surface links to content you have not paid for. Those consequences are yours,
        not the application's, which is why nothing ships with it enabled and why the
        source list shows which sources have it on. Scans with it on are paced ten times
        slower.
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
