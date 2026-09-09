# GoTek Manager

A native desktop application for cataloguing retro-software images and preparing
GoTek-compatible media on Linux, Windows, macOS, and ARM64 Linux systems such as
Raspberry Pi.

## What it does

A **profile** is the unit you work with. It holds one destination (a folder, a
mounted volume, or a FAT image) together with the platform, firmware, folder
layout, and naming rules used to write to it. Each profile keeps its own
collection of staged titles.

The workflow is **Profile → Contents → Sources → Verify → Confirm → Summary**.
Choose a profile, inspect what its destination holds, stage moves or deletions,
add titles from indexed local folders or online catalogues, compare the
destination before and after, and confirm. Nothing is applied until you type the
profile's exact name.

- Tauri + React desktop application with system, light, and dark themes.
- Recursive local indexing, including supported images inside ZIP archives,
  with explicit platform assignment for formats shared by several machines.
- Optional conversion of images a GoTek cannot present into ones it can,
  `.msa` to `.st` and `.scl` to `.trd`, written into the cache during indexing,
  leaving the original file untouched. Anything that cannot be converted
  cleanly is left out rather than guessed at.
- Persistent named source locations that can be re-indexed, renamed, or removed.
- Read-only browsing of folders, mounted volumes, Linux GVFS desktop mounts such
  as SMB shares, and FAT `.img`/`.ima` images.
- Categories (games, applications, demos, magazines, utilities, music,
  education, system) worked out from the folders an organised collection already
  uses, including the compound names collections take from their own catalogues
  such as `Commodore Amiga - Games - [ADF]`, from the name of the archive a title
  sits in, from the sections a site sorts its own downloads into, and failing
  those from a title's own name on whole words; anything unrecognised stays
  Unsorted rather than being guessed at. A bracketed `(demo)` is read as a
  playable demo of a commercial game rather than a demoscene production, so game
  demos do not end up filed with the demoscene. A Category folder layout splits a
  stick by what the titles are, and `{category}` is a folder-template token too,
  so a multi-machine stick can be `{platform}/{category}`.
- A destination that already sorts itself keeps its own folder names. A stick
  holding `Applications/` is offered them rather than having `Apps/` written
  beside it, and the choice is confirmed on the profile rather than applied
  silently.
- One name for a title however it arrived. A file written to the drive is called
  what the software is and nothing else: `Dungeon Master (1987)(FTL)(GB)(Disk 1
  of 2)[cr QTX].adf` becomes `Dungeon Master D1.adf`, and a one-disc game gets no
  disc marker at all. The year, publisher, region, language, version and dump
  flags are all left in the library, which keeps the original name. A local scan,
  a bulk add and an online download all go through the same rule, so a stick is
  never a mixture of two conventions. Naming for a small panel is a separate
  choice, and the disc marker is never what gives up the room.
- Filling a stick from a whole collection in one pass, using **Scan all
  sources** below **Add location** on the Sources step. The filter is built from
  what the collection itself records: language, prototypes and playable demos,
  dumps marked cracked, alternate or bad, how the software was published,
  region, and category, each choice showing how many titles carry it. Where a
  name says which country a release was sold in but never says a language, the
  country answers: real collections mark thousands of German releases `(DE)` and
  never write `(de)` at all, and read strictly every one of those would slip
  past a filter asking for English. A multi-disc set is
  taken whole from one release where one is whole and filled disc by disc where
  none is, and a set missing a disc is left out and named rather than half
  written. Where several copies of a title survive, one is chosen: the original
  first, then the fixed dump, then the alternates. Nothing is staged before the
  preview has said how many titles it would add and which folder on the drive each
  would land in.
- Downloads join one source per site rather than one per download, so the list of
  local sources stays the folders you chose.
- A chosen destination becomes a profile only once its platform and firmware have
  been confirmed, rather than being guessed from the folder name and applied
  silently.
- Tick boxes on every list of disk images, with shift-click for a run, so titles
  can be added to a profile or taken back out in bulk, destination files moved or
  deleted together, and whole selections downloaded in one go.
- Merged destination previews showing additions, removals, conflicts, moves, and
  unchanged files before anything happens.
- Transfer plans with collision, source-change, and free-space checks.
- Verified, non-overwriting copies to folders and mounted volumes.
- Extensible platform catalogue covering the initial Acorn, Amstrad, Commodore,
  Sinclair, and Atari systems, listing only formats a floppy emulator can
  actually present.
- The drive's own `FF.CFG` written alongside the images, with the settings
  FlashFloppy documents for the machine being prepared and nothing else. A
  profile can name the panel fitted to its drive, including the rotated variants
  that put an upside-down OLED the right way up. A configuration already on the
  drive is updated rather than overwritten: the settings this application is
  responsible for change in place, and everything else in the file is kept,
  including interface, display order, font, contrast, comments and line
  endings. It goes
  wherever the firmware actually reads it from, and one already on the stick is
  never replaced without being asked for.
- FlashFloppy, HxC, and factory firmware profiles, with conservative detection
  from configuration files found on the media. Accepted formats are the overlap
  of the machine and the firmware, so the application never claims a format will
  work when that pairing cannot load it.
- Online catalogues with per-platform caching: Internet Archive search and item
  browsing, the Demozoo production API, structured JSON feeds, and bounded
  robots-aware site inspection. The list of sites is a JSON file that can be
  replaced without touching the code. Every source names the one machine it is
  for, and a listing entry that names another machine is held back, so an Amstrad
  compilation cannot be offered for a BBC stick.
- Known-title coverage comparison that marks local holdings and likely gaps.
- Streamed HTTPS downloads with provenance, cache reuse, size limits, and safe
  multi-image ZIP extraction.
- Archives in a library are listed, not unpacked: a scan reads each ZIP's
  directory and records what it holds, and a title is read out of its archive
  only when it is written. A folder of a few thousand archives is indexed in
  seconds rather than decompressed in full, and nothing is cached that was never
  asked for.
- Bounded, policy-aware site inspection that asks what a link is before reading
  it: a HEAD says page or file, so a download is never fetched merely to be
  identified, and a title behind a script such as `dl.php?id=...` is recognised
  and named from the file the server sends. What each path turns out to be is
  remembered, so the downloads are found rather than the crawl exhausting itself
  on navigation.
- A library too large to compare in a moment says so instead of stalling: past a
  few hundred titles the content comparison is offered rather than run, and the
  table draws a page at a time.
- Physical device inventory with vendor, model, serial, size, and the full
  partition graph, and refusal of any device carrying the running system.
  Devices can be filtered by kind, and each carries an icon for the medium it
  is.
- **Devices** is where a stick is written. Pick a profile by name and its
  destination is copied to the media, whether that destination is a folder, a
  mounted volume or a FAT image. A stick that is already formatted for a GoTek
  and mounted by the desktop is copied to rather than rebuilt, so only the files
  it is missing move and everything else on it is left alone; formatting is
  offered for a stick that needs it, or to start again from empty. The
  difference matters: rebuilding an eight gigabyte stick reads and writes eight
  gigabytes to deliver one gigabyte of games. The running total is counted in
  clusters
  rather than bytes, because an 881 KB disk image on a 32 KB cluster costs
  896 KB and across ten thousand titles that difference decides whether a write
  fits.
- When a collection does not fit, the difference is settled before anything is
  written rather than after a failure. Cancel, choose what to leave out by hand
  in a tree with a tick against everything, or let the application choose. It
  proposes rather than decides: the same tree opens with its choices already
  made, each one saying how much it saved, and every one can be put back. It
  gives up formats the drive cannot load first, then setup and system disks,
  then whole categories, with games last. Whole titles go rather than single
  discs, because a game missing a disc is dead weight. What is left out applies
  to that one write, and the profile's own folder is never touched.
- Guarded device provisioning: the media is built as an image first, then written
  in one pass and read back to verify.
- FAT image creation, population, and unpacking, for partitioned and bare layouts.
- Three naming rules (the title alone, the title shortened to the drive's
  display width, or the collection's original filename) plus custom folder
  templates, per-title display names, and optional checksum verification on
  every copy.
- A managed download cache with size limits, least-recently-used eviction, and
  digests re-checked on reuse.
- A SQLite library that is queried rather than loaded. The library page asks
  for the page it is drawing, with the filtering, ordering and paging done by
  the database, and a change writes only the rows it names. A collection of
  forty-five thousand titles opens in about two seconds and staging a title is
  immediate, so several large profiles cost no more to open than one.
- In-app help covering the guided flow, illustrated with screenshots captured
  from the running application in both light and dark palettes.

Writing a whole device is **not** implemented on Windows: it needs volume
locking through the Win32 API, and shipping that untested could corrupt a disk.
`.hfe` conversion is not implemented either. That needs an MFM encoder and real
fixtures, and a blind implementation would produce unreadable media. Online
access is provider- and policy-dependent: the application does not bypass
authentication, payment, licensing restrictions, `robots.txt`, or prohibited
download routes.

**Device provisioning has never been run against real hardware.** It is
extensively unit-tested, including the copy-and-verify path, but use a spare USB
stick the first time.

## Safety

This application works with real removable media, so every write path is treated
as high-risk.

- Discovery and planning are read-only. Nothing is added to your workspace
  without you selecting it.
- Nothing is ever overwritten. A destination path holding different content
  becomes a conflict and blocks the plan.
- The plan is rebuilt from the destination immediately before writing, so media
  swapped after you confirmed cannot be written with stale expectations.
- Each file is copied to a temporary name, flushed to the device, size-verified,
  and only then moved into place, so an interrupted copy cannot leave a
  truncated file that looks like a valid disk image.
- Destination paths cannot escape the profile's folder, and a symbolic link
  inside the destination cannot redirect a write.
- System locations are refused on every platform.
- A device is addressed by node, model, serial, and size, never by where it is
  mounted, and is re-resolved immediately before writing. A stick swapped after
  planning is a different device and is refused.
- Formatting a device needs a typed phrase naming that exact device, including
  the tail of its serial, so it cannot be confirmed from memory. Copying onto a
  stick that is already formatted erases nothing and so does not ask for it.
- The media is built as an image file first, so a device is never left
  half-formatted, and it is read back and compared afterwards.
- **Keep** preserves everything already on the destination. **Remove** deletes
  only files in the formats this drive can actually load that the collection does
  not contain; anything else, firmware configuration included, is kept and
  flagged as a profile mismatch.

## Development

Install Node.js 20+, a stable Rust toolchain, and the Linux WebKit/GTK
development packages:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libsoup-3.0-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

Then:

```bash
npm install
npm run tauri dev
```

### Verifying a change

```bash
npm run verify
```

That runs five things, which can also be run on their own:

| Command | What it covers |
| --- | --- |
| `npm run build` | TypeScript type-checking and the production frontend build |
| `npm run lint` | Mistakes the compiler cannot see: promises nothing waits on, values that have escaped their types, code nothing reaches |
| `npm run check:format` | That Prettier and rustfmt would leave the sources as they are. `npm run format` writes the frontend half |
| `npm run check` | Frontend domain rules, the workspace reducer, storage migration, and a headless render of the application |
| `npm run check:native` | The Rust suite: path safety, device rules, planning, transfers, caching, robots handling, and archive extraction |

The stylesheet, the prose, and the workflow files are left alone by the
formatter, as are a handful of tables that are laid out a row to a line on
purpose. `eslint.config.js` says which linting rules are switched off and why.

To refresh the in-app help images after changing a screen:

```bash
npm run screenshots
```

This drives the real application through the guided flow against fixture folders
and photographs each step in both palettes. It needs ImageMagick, `xwininfo`,
and an X11 or XWayland display.

`npm run check:native -- --ignored` additionally runs the opt-in test that
reaches a live third-party site. It is excluded by default so the suite stays
offline.

## Distributable packages

Build all standard Linux formats with one command:

```bash
npm run package:linux
```

This produces `.deb`, `.rpm`, and AppImage artifacts under
`src-tauri/target/release/bundle/`. CI also builds ARM64 Debian packages for
64-bit Raspberry Pi OS, Windows x64 installers, and Intel and Apple Silicon
macOS bundles.

On Debian/Ubuntu build hosts, install `rpm` once before building that artifact:

```bash
sudo apt-get install -y rpm
```

Install the resulting `.deb` with:

```bash
sudo apt install ./src-tauri/target/release/bundle/deb/gotek-manager_0.1.0_amd64.deb
```

`gotek-manager` is the fixed native executable name in every build. Debian and
RPM packages install it into the system command path. Windows installers provide
`gotek-manager.exe` with Start menu integration. macOS bundles provide
`GoTek Manager.app`. AppImage files are self-contained and launched by their
downloaded filename.

Use `npm run package:deb`, `npm run package:rpm`, or `npm run package:appimage`
for a single Linux format. Windows and macOS releases are built on native
runners with `npm run package:windows` (MSI/NSIS) and `npm run package:macos`
(`.app`/DMG).

The included GitHub Actions workflow builds all of these on their native
operating systems when manually dispatched or when a `v*` tag is pushed.
Signing and notarisation credentials must be added before publishing public
Windows or macOS releases.
