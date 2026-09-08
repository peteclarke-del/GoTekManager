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

import { useEffect, useState, type ReactNode } from 'react'
import { CircleCheck, Download, RefreshCw } from 'lucide-react'
import { newerRelease } from '../domain/version'
import type { PublishedRelease, ThemeChoice } from '../domain/types'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { useResolvedTheme } from '../hooks/useResolvedTheme'
import { appVersion, openExternal, publishedReleases } from '../native/commands'
import { DEVICES_SCREEN, FLOW_SCREENS, PROFILES_SCREEN } from './helpScreens'

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
        combines them, as in <code>{'{platform}/{category}'}</code>. If the destination
        already sorts itself and spells a folder differently, <code>Applications</code>
        rather than <code>Apps</code>, it can be told to use the folders already there,
        so titles fill them instead of a second set appearing beside them.
        <br />
        <br />
        Naming decides what a file is called once it reaches the drive.{' '}
        <b>Title only</b> writes the name of the game or application and nothing else:{' '}
        <code>Dungeon Master (1987)(FTL)(GB)[cr QTX].adf</code> becomes{' '}
        <code>Dungeon Master.adf</code>, with a disc marker added only when the set has
        more than one disc. <b>Shortened for the display</b> is the same name cut to the
        firmware's display width, and the disc is never what gives up the room.{' '}
        <b>Original filename</b> keeps whatever the collection called it. The library
        always keeps the canonical name, and source files are never renamed or moved.
      </>
    ),
  },
  {
    question: 'Where do categories come from?',
    answer: (
      <>
        From the best evidence there is, in order. The folders a collection already
        uses: a title under <code>Applications</code> or <code>Games [ADF]</code> is
        read as one, deepest folder first. For a download there are none, so the site's
        own sections answer instead, and failing that the title's own name, matched on
        whole words so "Demolition Man" is not a demo. A folder named after a
        collection's own catalogue reads too, as in{' '}
        <code>Commodore Amiga - Games - [ADF]</code>. A bracketed{' '}
        <code>(demo)</code> is a playable demo of a commercial game rather than a
        demoscene production, so it does not file a title under Demos. Anything
        unrecognised is left Unsorted rather than guessed at, because a wrong category is
        silent and puts a title in the wrong folder on the drive. Set those in the
        library table, several at a time with the tick boxes.
      </>
    ),
  },
  {
    question: 'Can I fill a stick from my whole collection at once?',
    answer: (
      <>
        Yes. <b>Scan all sources</b>, below <b>Add location</b> on the Sources step,
        re-indexes every local source and then offers a filter built from what the collection itself
        records:
        language, unfinished builds such as prototypes and playable demos, dumps marked
        cracked or bad, how the software was published, region, and category. Every
        choice shows how many titles carry it, so it is made against the library in front
        of you.
        <br />
        <br />
        Two rules do most of the work. A multi-disc set is only useful whole, so discs
        are chosen together and a set missing one is left out and named rather than
        half written. And where several copies of one title survive the filter, one is
        chosen: the original first, then the fixed dump, then the alternates, and so on
        down. Nothing is staged until you have seen how many titles it would add and
        which folder on the drive each of them would land in.
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
        Verified copies into a folder, a mounted volume or a FAT image, and a whole
        storage device from the Devices page. Nothing is ever overwritten: a
        destination path that already holds different content becomes a conflict and
        blocks the plan. Writing a whole device is not available on Windows, and{' '}
        <code>.hfe</code> conversion is not implemented.
      </>
    ),
  },
  {
    question: 'How do I copy a profile onto a memory stick?',
    answer: (
      <>
        On the <b>Devices</b> page, choose the device and then pick the profile by
        name. What gets written is the contents of that profile’s destination, so
        the folder you curated is the thing that reaches the stick.
        <br />
        <br />
        Space is counted the way the drive counts it, in whole clusters rather than
        bytes, because an 881 KB disk image on a 32 KB cluster really occupies 896 KB
        and across ten thousand titles that difference decides whether a write fits.
        If it does not fit you are told before anything is written, and offered three
        ways out: cancel, choose what to leave out yourself, or let the application
        choose.
        <br />
        <br />
        Choosing for you proposes rather than decides. The same tree opens with its
        choices already made and each one saying how much it saved, and every one can
        be put back. It gives up formats the drive cannot load first, then setup and
        system disks, then whole categories, leaving games until last. Whole titles
        go rather than single discs, because a game missing a disc is dead weight.
        What you leave out applies to that one write: the profile’s own folder is
        not changed, and the next write starts from everything again.
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
      <Version />
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
        <h2>Writing to a stick</h2>
        <p>
          The devices screen lists the removable media it can see, with the vendor,
          model, serial and partitions of each, and refuses the disk the running
          system is on. Pick a profile by name and its destination folder is what
          gets written: the folder is the master and the stick is a copy of it, so
          nothing is laid out again on the way.
        </p>
        <p>
          There are two routes onto the stick, and which one is offered depends on
          what is already there. A stick formatted for a GoTek and mounted by the
          desktop is copied to, which moves only the files it does not already hold
          and leaves the rest of it alone. A stick that cannot be written to that
          way is formatted instead: the media is built as an image first, written in
          one pass, and read back to check it. Formatting erases the stick, so it
          asks you to type the name of that exact device, serial included, before it
          will start.
        </p>
        <div className="help-shots">
          <Screenshot
            theme={resolved}
            name={DEVICES_SCREEN.name}
            title={DEVICES_SCREEN.title}
            caption={DEVICES_SCREEN.detail}
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

/**
 * Which version this is, and, when asked, whether a newer one is published.
 *
 * The check is a button rather than something that happens on startup: a tool
 * that writes to removable media should not be reaching out to the internet
 * unless someone has asked it a question.
 *
 * Not being able to answer is not a failure. No network, no releases yet, an
 * API that has moved. None of those mean anything is wrong with the copy in
 * front of the user, so they are reported as what they are: the question could
 * not be answered. Installing is left to the user and, on Linux, to their
 * package manager; this only says there is something to go and get.
 */
function Version() {
  const [version, setVersion] = useState('')
  const [newer, setNewer] = useState<PublishedRelease | null>(null)
  const [answered, setAnswered] = useState(false)
  const check = useAsyncAction()

  useEffect(() => {
    appVersion().then(setVersion, () => setVersion(''))
  }, [])

  const askGitHub = () =>
    void check.run(async () => {
      const releases = await publishedReleases()
      setAnswered(releases.length > 0)
      setNewer(newerRelease(releases, version) ?? null)
    })

  return (
    <section className="panel version-panel">
      <div>
        <h2>GoTek Manager {version || '—'}</h2>
        <p>
          {check.busy
            ? 'Asking GitHub what has been published…'
            : newer
              ? `Version ${newer.tag} has been published.`
              : answered
                ? 'This is the latest published version.'
                : 'Nothing is sent anywhere until you ask.'}
        </p>
      </div>
      <div className="version-actions">
        <button className="button secondary compact" disabled={check.busy} onClick={askGitHub}>
          <RefreshCw className={check.busy ? 'spinning' : ''} />
          Check for updates
        </button>
        {newer && (
          <button
            className="button compact"
            onClick={() => void openExternal(newer.url)}
          >
            <Download />
            Open the release page
          </button>
        )}
        {!newer && answered && <CircleCheck className="version-current" />}
      </div>
      {check.error && <p className="inline-error">{check.error}</p>}
      {!check.busy && !check.error && !answered && newer === null && version && (
        <p className="mode-note version-note">
          A check that comes back with nothing, whether from no network or a
          repository with no releases, is not an answer, and is never read as
          "this is the latest".
        </p>
      )}
      {newer && (
        <>
          <p className="mode-note">
            <b>{newer.name}</b>. Installing is yours to do, from the release page; on
            Linux your package manager holds the copy that is installed.
          </p>
          {newer.notes && <pre className="drive-config-file">{newer.notes}</pre>}
        </>
      )}
    </section>
  )
}
