# GoTek Manager

A native desktop application for cataloguing retro-software images and preparing
GoTek-compatible media on Linux, Windows, macOS, and ARM64 Linux systems such as
Raspberry Pi.

## What it does

A **profile** is the unit you work with. It holds one destination — a folder, a
mounted volume, or a FAT image — together with the platform, firmware, folder
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
- Optional conversion of images a GoTek cannot present into ones it can —
  `.msa` to `.st` and `.scl` to `.trd` — written into the cache during indexing,
  leaving the original file untouched. Anything that cannot be converted
  cleanly is left out rather than guessed at.
- Persistent named source locations that can be re-indexed, renamed, or removed.
- Read-only browsing of folders, mounted volumes, Linux GVFS desktop mounts such
  as SMB shares, and FAT `.img`/`.ima` images.
- Merged destination previews showing additions, removals, conflicts, moves, and
  unchanged files before anything happens.
- Transfer plans with collision, source-change, and free-space checks.
- Verified, non-overwriting copies to folders and mounted volumes.
- Extensible platform catalogue covering the initial Acorn, Amstrad, Commodore,
  Sinclair, and Atari systems, listing only formats a floppy emulator can
  actually present.
- FlashFloppy, HxC, and factory firmware profiles, with conservative detection
  from configuration files found on the media. Accepted formats are the overlap
  of the machine and the firmware, so the application never claims a format will
  work when that pairing cannot load it.
- Online catalogues with per-platform caching: Internet Archive search and item
  browsing, the Demozoo production API, structured JSON feeds, and bounded
  robots-aware site inspection. The list of sites is a JSON file that can be
  replaced without touching the code.
- Known-title coverage comparison that marks local holdings and likely gaps.
- Streamed HTTPS downloads with provenance, cache reuse, size limits, and safe
  multi-image ZIP extraction.
- Physical device inventory with vendor, model, serial, size, and the full
  partition graph, and refusal of any device carrying the running system.
- Guarded device provisioning: the media is built as an image first, then written
  in one pass and read back to verify.
- FAT image creation, population, and unpacking, for partitioned and bare layouts.
- Custom folder templates, per-title display names, and optional checksum
  verification on every copy.
- A managed download cache with size limits, least-recently-used eviction, and
  digests re-checked on reuse.
- A transactional SQLite library, so a few thousand titles is no longer near a
  storage limit.
- In-app help covering the guided flow, illustrated with screenshots captured
  from the running application in both light and dark palettes.

Writing a whole device is **not** implemented on Windows: it needs volume
locking through the Win32 API, and shipping that untested could corrupt a disk.
`.hfe` conversion is not implemented either — that needs an MFM encoder and real
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
- Writing to a device needs a typed phrase naming that exact device, including
  the tail of its serial, so it cannot be confirmed from memory.
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

That runs three things, which can also be run on their own:

| Command | What it covers |
| --- | --- |
| `npm run build` | TypeScript type-checking and the production frontend build |
| `npm run check` | Frontend domain rules, the workspace reducer, storage migration, and a headless render of the application |
| `npm run check:native` | The Rust suite: path safety, device rules, planning, transfers, caching, robots handling, and archive extraction |

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
