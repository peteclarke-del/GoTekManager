GoTek Manager catalogues retro-software disk images and prepares media for a
GoTek floppy emulator: it indexes your library, works out which titles a given
machine and firmware can actually load, and writes them to a stick with the
drive's own configuration alongside them.

## What is new in 0.6.1

**The theme that follows your desktop now looks like the dark theme.** Picking
Dark yourself and letting the application follow the desktop are two different
settings, and the second had fallen behind the first: twenty-two things carried
a colour for the dark theme and none for the desktop one, so on a dark desktop
they kept their light colours. The panel that says a profile will not fit on a
stick was the worst of them, keeping a light background under pale text, which
left the buttons on it unreadable. The capacity figures, the state of each
title in the table, the progress dialogs and the sidebar were all affected in
smaller ways.

The two are compared by the checks now, so they cannot drift apart again
without somebody being told.

## What is new in 0.6.0

**A name too long for the drive's panel is cut where the name has a seam.** It
used to be cut at whatever character the room ran out at, which left
`Indianapolis 500 - The Simulation` written as `Indianapolis 500 - T`: neither
the name of the game nor anything else. On a collection of sixty-six thousand
Amiga titles, nineteen thousand are too long for a twenty-four character panel
and thirteen thousand of those were being cut through the middle of a word.

A subtitle now goes first, because `Indianapolis 500` is still the game and
`The Simulation` was only saying which edition of it this is. Failing that,
whole words go from the end, and only while enough of the name survives to be
recognised. Cutting mid-word is still there for a name that offers no seam at
all, which on that collection is three and a half thousand titles rather than
thirteen.

**A number at the end of a title is no longer rewritten.** This was the part
worth fixing rather than merely improving: `Compilation Disk #04672` was
written as `Compilation Disk #04`, which is a different disk and looks like a
perfectly good name. The number is the one part saying which of these this is,
so it stays and the words in front of it give up the room instead, giving
`Compilation #04672`. `Championship Manager '93` keeps the year that tells it
from '94 for the same reason.

The rule that the title gives up room and never the disc is unchanged.

**If you have already written a stick with an earlier version**, the names on
it were cut the old way and will not match the names this version writes. The
drive will show some titles twice until that stick is written again.

## What is new in 0.5.2

**A source you have just indexed says how many titles it holds.** Since 0.5.0
the library is queried rather than carried about, and a query is only asked
again when the question changes: a different machine, a search, a sort, another
page. Adding a source and scanning it writes thousands of rows behind that
question without changing it, so nothing asked again and the source sat there
reporting no titles at all, until something else happened to move the filter and
the count appeared minutes later. The titles were never missing. A change to the
library now says so, and the table and the counts beside it listen.

**The bulk add sees what its own scan found.** It reads every candidate when it
opens, which is what lets it choose between releases of a title, and its own
**Scan all sources** could not reach that copy. Starting from an empty library
meant watching a scan index thousands of titles and then be told there was
nothing to add.

**A workspace you deleted stays deleted.** An empty database is the signal to
adopt whatever an older version left in local storage, and that adoption kept
the copy rather than taking it. Anything that emptied the database brought the
old profiles back, and nothing in the application could refuse them: clearing
everything to start again handed you a profile you had deleted. The old copy is
now forgotten once the database has taken it. Your theme, table layout and
online providers are not affected; those are kept in the same place by the
current version and stay where they are.

## What is new in 0.5.1

**Titles the library was never able to sort are sorted.** A category is worked
out when a title is indexed and then kept, which is what makes a category you
set by hand stick. The cost of keeping it is that a collection carries the
answers the rules gave at the time, and the rules have improved several times:
reading a folder named after a collection's own catalogue, reading an archive's
name, and reading the source folder all arrived after most libraries were built.
Until 0.5.0 that was covered up, because the whole library was re-derived every
time it loaded, and it stopped being loaded whole in the same release that
improved the rules.

So the titles that were never sorted are asked again, once, the next time this
version opens the library. Only those rows are read, and only the ones that can
now be answered are written back. On the collection that prompted this, nine
thousand titles with two thousand six hundred and ninety-three unsorted between
them came down to eighteen, which were cached downloads with no folders to read.

A category that already says something is never touched, whether the rules
worked it out or you chose it, because there is no way to tell those apart
afterwards. To change one that is wrong, set it by hand, or re-scan the source,
which works its categories out again from scratch.

## What is new in 0.5.0

**A stick can be filled from a whole collection in one pass.** **Scan all sources**,
below **Add location** on the Sources step, re-indexes every local source and then offers a
filter built from what the collection itself records: language, unfinished builds such
as prototypes and playable demos, dumps marked cracked, alternate or bad, how the
software was published, region, and category. Every choice says how many titles carry
it, so it is made against the library in front of you rather than in the abstract.
Nothing is staged until the preview has said how many titles it would add, which folder
on the drive each would land in, how much room they need, and what was left out and why.

**A multi-disc set is only useful whole**, so discs are chosen together rather than
separately. A set is taken from one release where one release holds all of it, filled
disc by disc and reported as mixed where none does, and left out and named where a disc
is missing altogether, because two thirds of a game is worse than none of it. And where
several
copies of one title survive the filter, one is chosen: the original first, then the
fixed dump, then the alternates, and so on down.

**A file is named for what it is.** Everything a collection records about a release, the
year, the publisher, the region, the language, the version and the dump flags, says which
copy this is rather than what the software is, and none of it fits a two-line display.
`Dungeon Master (1987)(FTL)(GB)(Disk 1 of 2)[cr QTX].adf` is now written as
`Dungeon Master D1.adf`, and a one-disc game gets no disc marker at all. The library
keeps the original name either way. A folder scan, a bulk add, an online download and a
title staged by hand all go through the same rule, so a stick is never a mixture of two
conventions. Naming for a small panel is now a separate choice from stripping the tags,
and **Original filename** is still there for anyone who wants their collection's names
verbatim. Existing profiles keep whatever they were set to; new ones start on
**Title only**.

Reducing names this way is also what makes two titles collide, since two editions of
Elite both become `Elite.adf`. Where that happens the later one keeps the smallest thing
the collection recorded that tells them apart, rather than the write being refused.

**Categories read more of the evidence.** A folder named after a collection's own
catalogue now reads, which had left whole trees such as
`Commodore Amiga - Games - [ADF]` unsorted. A bracketed `(demo)` is a playable demo of a
commercial game rather than a demoscene production, so game demos no longer file
themselves with the demoscene. An archive's own name says what its contents are and what
they are called, which is all a single-title ZIP holding `disk1.adf` has to go on.

**A destination that already sorts itself keeps its own folder names.** A stick holding
`Applications/` is offered them rather than having `Apps/` written beside it, so titles
fill the folders already there instead of a second set appearing next to them. It is
offered on the Contents step and confirmed on the profile, never applied silently.

**Devices is where a stick is written.** Pick a profile by name and its destination
folder is what gets written: the folder is the master and the stick is a copy of it, so
nothing is laid out again on the way. There are two routes onto the stick, and which one
is offered depends on what is already there. A stick already formatted for a GoTek and
mounted by the desktop is copied to, which moves only the files it does not already hold
and leaves everything else on it alone. A stick that cannot be written to that way is
formatted instead: the media is built as an image first, written in one pass, and read
back to check it. The difference is worth having. Rebuilding an eight gigabyte stick
reads and writes eight gigabytes to deliver one gigabyte of games, and erases what was
there. Formatting still asks you to type the name of that exact device, serial included;
copying erases nothing and so does not ask.

**A large library opens in about two seconds rather than twenty.** A collection of
forty-five thousand titles used to be read in full before the window showed anything,
and saved in full on every change. The library is now queried rather than carried about:
the page you are looking at is the page the database is asked for, and staging a title
writes the row for that title. Several large profiles cost no more to open than one.

**A release is read as being in the language of the country it was sold in**, where it
states no language of its own. The convention is that `(de)` is German and `(DE)` is
Germany, and real collections are nothing like that disciplined: a set can mark thousands
of German releases `(DE)` and never write a language at all. Read strictly, every one of
those states nothing, so an "English only" filter that kept untagged titles let the lot
through.

**"The database is locked" is fixed**, for the last case that still produced it: a save
that overlapped a scan was refused outright rather than waiting its turn. Cached content
digests are also swept when the application starts, so a library that has been
reorganised a few times stops carrying rows for files that no longer exist. Digests for a
drive that is merely unplugged are kept, since reading a whole library again is hours of
work.

**Upgrading.** The stored library moves to schema 6 the first time this version opens
it, in place: schema 5 carries the folder names a destination uses, and schema 6 gives
each title's machines a table of their own so the database can answer a page of the
library without reading all of it. A profile written by an older version arrives with no
folder names of its own and uses the standard ones. An older version opening the library
afterwards will say so and stop rather than quietly downgrade.

## What is new in 0.4.0

**Multi-disk sets write properly.** Shortening a name for the drive's display
threw away the letter or number saying which disk of a set a file was — it sits
at the end, which is where trimming cut — so every disk of a set arrived at one
name and the write refused. The disk now survives, and it is the middle of a
name that gives way instead: what sits in brackets is the publisher, and
"Another World (Delphine + U.S. Gold) A.adf" is written as "Another World A.adf".

**A write that cannot go ahead says what to do about it.** Verify used to list
its reasons and leave the button dark. It now names the staged titles standing in
the way — two that would be written over one another, one whose file has gone
from the cache — and offers to take them out.

**Titles are readable.** The title column was the narrowest in the table; it is
now the widest, a long name loses its middle rather than its ends, and hovering
gives the name in full.

**Downloads belong to the site they came from**, not to a source apiece. A
library that grew a source per download tidies itself up when it is read.

**Categories are worked out from more than folders.** A download has no folders
to read, so the site's own sections answer instead — a title found under
"demos" is one — and failing that the title's own name, on whole words only.
Anything unrecognised stays Unsorted rather than being guessed at.

## What is new in 0.3.0

**Help says which version this is**, taken from the application itself rather
than from a constant that can drift, and offers a **Check for updates** button
that asks GitHub what has been published. It is a button rather than something
that happens on startup: a tool that writes to removable media should not be
reaching out to the internet unless someone has asked it a question. A check
that cannot be answered — no network, or an API that has moved — says so, and is
never read as "you are up to date". Installing is left to you and, on Linux, to
your package manager; the check only says there is something to go and get.

## What is new in 0.2.0

**Working a library of thousands.** Tick boxes on every list of disk images,
with shift-click for a run: add or remove a selection from a profile, delete or
move destination files together, download a selection of online titles, or take
staged additions back out before writing. A title that can be added can now be
taken out again, which it could not before.

**Categories.** A title carries what it is — games, applications, demos,
magazines and the rest — read from the folders an organised collection already
uses, and set by hand for the rest. A category layout splits a stick by it, and
`{category}` joins the folder-template tokens, so `{platform}/{category}` works
for a multi-machine stick.

**Archives are listed, not unpacked.** A ZIP in a library has its directory read
and its contents recorded; a title is decompressed only when it is written.
Indexing a few thousand archives on a network share takes about a minute rather
than the time to decompress all of them, and nothing is cached that was never
asked for.

**Large libraries stay responsive.** The title table draws a page at a time, and
past a few hundred titles the content comparison with the destination is offered
rather than run — answering it means reading every title, which is minutes over
a network share, and adding and writing titles does not need it.

**Online sources are tied to one machine.** Every source names the machine it is
for, and a listed title that names another machine is held back, so an Amstrad
compilation is never offered for a BBC stick. A site's links are asked what they
are before being read, so a title behind a download script is recognised and
named from the file the server sends rather than missed.

**Profiles and the drive's own configuration.** A chosen destination becomes a
profile only once its platform and firmware are confirmed, rather than being
guessed from the folder name. A profile can name the panel fitted to its drive,
including the rotated variants that put an upside-down OLED the right way up. An
`FF.CFG` already on a stick is updated rather than overwritten: only the settings
this application is responsible for change, and everything a drive was tuned
with by hand is kept.

**Upgrading.** The stored library moves to schema 4 the first time this version
opens it, in place. An older version opening it afterwards will say so and stop
rather than quietly downgrade.

## Downloads

| Platform | File |
| --- | --- |
| Windows (x64 / ARM64) | `.msi`, or `.exe` for the NSIS installer |
| macOS (Apple Silicon / Intel) | `.dmg` |
| Linux (x86-64 / ARM64) | `.deb`, `.rpm`, or `.AppImage` |

The Linux ARM64 build covers the Raspberry Pi. None of the packages are signed,
so Windows SmartScreen and macOS Gatekeeper will both want convincing.

## Please read before writing to a device

**Device provisioning has never been run against real hardware.** Every guard
around it is tested, and the copy-and-verify core is tested, but the first
physical write of a whole device is unproven. Use a spare stick.

Image conversion (`.msa` to `.st`, `.scl` to `.trd`) is proven against bytes
built from the format specifications rather than against a drive that has
loaded the result, and the `FF.CFG` written to a stick follows FlashFloppy's
documentation rather than a drive that has read it back.

Copying files to a mounted stick, which is what most people will do, verifies every
byte it writes and never overwrites in place.
