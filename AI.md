# GoTek Manager: AI project handover

## Purpose

GoTek Manager is a **native, portable desktop application** for initialising,
organising, and managing GoTek floppy-emulator storage and software-image
libraries on Linux, Windows, macOS, and ARM64 Linux systems such as Raspberry
Pi.

The application must support different GoTek firmware families, selecting and
restricting workflows according to the detected or user-selected drive profile
(for example FlashFloppy, HxC, and standard GoTek variants). It should be useful
both as a local retro-software librarian and as a safe physical-media
provisioning tool.

This document is the source of truth for an AI or developer taking over the
project. Do not infer that the current implementation has functionality which is
only described as a future requirement.

## Original requirements

### Media and targets

The user wants one coherent workflow for all of the following:

- A directly mounted GoTek USB drive. GoTek media is normally a USB-stick
  filesystem.
- An arbitrary mounted/local folder used as an equivalent target.
- Disk/container image files, including `.img` and `.hfe`.
- Conversion between the above: unpack an image into a USB/folder, create an
  image from a USB/folder, and switch among them at any time.
- A filesystem view that shows either the selected target's actual contents or
  the local filesystem.
- Physical-device auto-provisioning: allow the user to select a mounted USB
  device and provision it from an image or template.

Physical writes and formatting are explicitly desired, but they are destructive.
They must always be gated behind a detailed plan and unambiguous user
confirmation.

### Library and organisation

- Allow multiple local source folders.
- Detect available formats and identify their likely platforms.
- Know which formats the selected GoTek firmware supports.
- Track software and firmware lists per platform.
- Drag and drop selected titles into a target/transfer queue.
- Optionally organise output into sensible folders; this must be selectable, not
  compulsory.
- Offer intelligent output renaming suited to small GoTek OLED displays, while
  retaining original/canonical metadata in the library.
- Support online catalogues and known-software lists, including Internet Archive
  and machine-specific sources where their APIs, exports, and site policies
  permit access.
- Compare cached known-software lists with local libraries so users can identify
  likely missing titles.
- Download caching must retain source/version metadata and reuse cached
  downloads unless a newer upstream version is available.

Do not build unapproved scraping against third-party sites. Each provider needs a
source-specific integration, terms/licensing review, rate limiting, attribution,
and authentication model where applicable.

### Initial platform set

The system must be extensible. These platforms are the initial supported set:

1. Acorn BBC Micro
2. Acorn Electron
3. Amstrad CPC464
4. Amstrad CPC6128
5. Commodore Plus/4
6. Commodore 64
7. Commodore 128
8. Commodore Amiga
9. Sinclair Spectrum 48K
10. Sinclair Spectrum 128K / +2 / +3
11. Sinclair Spectrum Next
12. Atari ST
13. Atari 8-bit

### Product experience

- Light and dark themes.
- Comprehensive in-app help with real screenshots of the application.
- A polished, native-feeling Linux GUI that can be distributed portably.

## Technology choices

The project uses **Tauri 2 + React 18 + TypeScript + Vite**.

Why:

- Tauri produces native desktop applications for each supported operating
  system, with a much smaller distribution than Electron.
- Rust provides an appropriate backend for filesystem/device work where safety
  and explicit command boundaries matter.
- React provides fast iteration for the library, profile, and help UI.

The package manifest is [package.json](package.json). Tauri configuration is
[src-tauri/tauri.conf.json](src-tauri/tauri.conf.json).

## Domain model

### Formats: machine and firmware, not machine alone

A GoTek emulates a floppy drive, so only floppy disk images can be presented to
the host. Tape images, bare programs, cartridges, and flux/copy-protection
formats are absent from the catalogue because no firmware can load them.

Beyond that, support depends on **both** the machine and the firmware, so
`Platform.formats` and `FirmwareProfile.formats` are separate and the accepted
list is `acceptedFormats(platformId, firmwareId)` — their intersection.
FlashFloppy reads Atari 8-bit `.atr` directly while HxC does not; factory
firmware reads only raw sector images. The intersection is also what the Remove
policy manages, which keeps deletion as narrow as possible: a file this drive
cannot even load is not this profile's to delete.

Do not flatten these back into one list. The single-list model could not express
a real, common case and quietly told users a format would work when it would not.

### Profiles

One concept, one owner. A **profile** owns a destination together with every
rule used to write to it:

```ts
type Profile = {
  id: string            // `profile:<destination path>` — the path is the identity
  name: string
  destination: {
    kind: 'folder' | 'volume' | 'image'
    path: string
    device?, filesystem?, totalBytes?, availableBytes?, removable?
    detectedFirmwareId?   // evidence from configuration files, not identity
  }
  platformId, firmwareId, organise, folderLayout, naming
}
```

Everything a profile stages lives in `collections[profile.id]`, and its
Keep/Remove choice in `removalPolicies[profile.id]`. The profile id is derived
from the destination path so the same folder cannot be registered twice — a
folder picked by hand and the same folder discovered as a mount are one profile.

An earlier version split this across a `StorageTarget` and a separate
`SavedProfile` linked by id, with a duplicated `name` kept in step by hand. Do
not reintroduce that split.

## Current implementation status

The application has a functional local library in a transactional database,
read-only destination and FAT-image browsing, verified non-overwriting transfers
to folders and mounted volumes, policy-aware online catalogues with a managed
cache, filesystem-image creation and unpacking, real physical-device identity,
and **guarded destructive device provisioning**.

Provisioning has been written and unit-tested, but it has never been run against
a real GoTek stick on this machine. Treat the first physical write as unproven:
use a spare device.

### Frontend

`src/` is organised by responsibility. No file is a catch-all.

- `domain/` — pure rules with no I/O: the platform and firmware catalogue,
  media classification and naming, path handling, provider definitions, and
  small immutable collection helpers.
- `state/` — the workspace reducer, persistence, and the one-time migration from
  the pre-2.0 storage layout.
- `native/commands.ts` — the only module that imports `@tauri-apps/api`. Every
  command is typed here and goes through one guard.
- `hooks/` — `useAsyncAction`, `useDirectoryBrowser`, `useTransferPlan`.
- `components/` — `Modal`, `Feedback` (progress, empty, notice, inline status),
  `FileBrowserTable`, `MountPicker`, `SettingsDialog`, `ProfileEditor`.
- `pages/` — `flow/` for the six guided steps, plus `ProfilesPage` and
  `HelpPage`.

Two invariants worth preserving:

1. **The native planner is the single source of truth for the interface.**
   `plan.result` is a merged inventory in which every file that will exist on the
   destination is labelled. The "current", "changes", and "result" views are
   three filters over that one array, so they cannot disagree.
2. **Planning and applying share one request object.** `FlowPage` builds a
   single `TransferRequest`, hands it to `useTransferPlan`, and hands the *same*
   object to `executeTransfer`. If these were built separately they could drift,
   and the change the user approved would not be the change that happened.

### Native backend

`src-tauri/src/` is split by concern:

| Module | Responsibility |
| --- | --- |
| `error.rs` | One serialisable error type plus a `Context` trait |
| `store.rs` | The SQLite database: versioned schema, one transaction per save |
| `paths.rs` | Entries, extensions, safe relative/target paths, verbatim-prefix stripping, hashing and comparison |
| `cache.rs` | Every cache location, all resolved through Tauri's `app_cache_dir` |
| `archive.rs` | Safe, bounded, manifest-cached ZIP extraction |
| `media.rs` | `scan_folder`, `list_directory`, `list_image_directory`, `inspect_target` |
| `devices.rs` | Mount discovery and classification, firmware evidence, destination validation, writability probing |
| `transfer.rs` | `compare_target_files`, `plan_transfer`, `execute_transfer` |
| `hardware/` | Physical device identity, one pure parser per platform |
| `image/` | FAT image creation, population, reading, and unpacking; `mbr`, `region` |
| `provision.rs` | Destructive device provisioning, and every guard that refuses it |
| `online/` | `http`, `robots`, `archive_org`, `feed`, `website`, and the commands |
| `task.rs` | `blocking()` — keeps filesystem work off the UI thread |

Registered commands:

- `mounted_targets` — `sysinfo` disks plus Linux GVFS desktop mounts, each
  classified `removable` / `network` / `fixed` / `system` and given a display
  label. System mounts are hidden unless explicitly requested. Discovery never
  adds anything to the workspace by itself.
- `inspect_target` — whether a destination exists, its kind, whether it is
  really writable, its entry count, free and total space, and any firmware
  evidence. A missing destination is *reported*, not raised as an error.
- `scan_folder` — recursive index that never follows symbolic links and serves
  supported images found inside ZIP archives from the cache.
- `list_directory`, `list_image_directory` — browsing, the latter reading FAT
  `.img`/`.ima` containers without mounting them.
- `compare_target_files` — per-source New/Identical/Different/Unavailable,
  opening only paths that could actually collide.
- `plan_transfer` — read-only merged inventory with collision, source-change,
  and free-space checks.
- `execute_transfer` — re-plans from scratch, refuses any plan with a warning,
  then applies edits, copies, and removals.
- `refresh_provider`, `load_provider_catalog`, `browse_online_title`,
  `download_online_title`.

Metadata and preferences are persisted in the webview's local storage under
versioned keys (`gm.workspace.v2`, `gm.settings.v2`, `gm.providers.v2`,
`gm.tablePrefs.v2`). The pre-2.0 keys are read once and migrated, and are left in
place rather than deleted.

### Storage

The workspace lives in SQLite at `app_data_dir/gotek-manager.db`, with the schema
version in `PRAGMA user_version` and write-ahead logging on. A save is one
transaction that replaces the workspace wholesale, so an interrupted write cannot
leave a half-written library. Columns already exist for the richer metadata the
library is meant to grow into — digests, provenance, scan times — so adding it is
a migration rather than a redesign.

This replaced `localStorage`, which had outgrown its job: browsers cap it at a
few megabytes, **a write past the cap fails silently**, and a library of a few
thousand titles is already most of that budget. On first run the old
`localStorage` workspace, including the pre-2.0 layout, is read and written
across; the old keys are left in place.

Small preferences — theme, providers, table layout — deliberately stay in
`localStorage`. They are tiny and must be readable synchronously at first paint;
loading the theme asynchronously would flash the wrong palette on every start.

### Physical devices

`hardware/` reports whole devices with node, vendor, model, serial, size,
transport, and the full partition graph. Mount paths are never treated as
identity: `PhysicalDevice::identity()` is built only from properties that cannot
change while the same device stays plugged in, which is what lets a plan detect
that the stick was swapped.

A device carrying the running system is flagged and can never be a target. On
Linux that is found by walking mount points through LUKS and LVM children, not
just the partition itself; on Windows from the platform's own boot/system flags;
on macOS from `SystemImage` and the data-volume mount.

Each platform is a pure parser over its own tooling's output — `lsblk --json`,
PowerShell's storage cmdlets, `diskutil` through `plutil` — so the Windows and
macOS behaviour is unit-tested against captured fixtures from a Linux host.

### Images and provisioning

`image/` creates a partitioned or bare FAT volume, fills it, reads it, and
unpacks it, all in pure Rust with no external tools and no privileges. Existing
image browsing goes through the same code, so a real partitioned GoTek stick
image now opens where previously only a bare filesystem did.

Provisioning is built on top of that and the shape is deliberate: **the media is
assembled as an image file first, then copied to the device in one verified
pass.** Nothing partitions or formats a live device, so there is no window in
which a stick is half-formatted, and every decision about what the media will
contain is ordinary file I/O that is tested without hardware. Before a byte is
written the device is re-resolved by identity, the system flag is checked twice,
the image must fit, and the user must type a phrase naming that exact device
including the tail of its serial. Afterwards the device is read back and compared;
the operation is not reported as successful until that passes.

### Explicitly not implemented yet

- Native drag and drop from outside the application.
- **Writing a whole device on Windows.** It needs volume locking through the
  Win32 API; shipping that untested could corrupt a disk, so the command refuses
  with an explanation rather than guessing. Creating an image works everywhere.
- **`.hfe` conversion.** HFE files are identified and can be copied, but nothing
  converts to or from them: that needs an MFM encoder and real test fixtures, and
  a blind implementation would silently produce unreadable media. Supported
  conversions are deliberately limited to FAT image ↔ folder, both validated.
- Converting `.msa`, `.scl`, `.d64`, and other formats outside a firmware's
  direct support. The interface says so rather than pretending.
- Authenticated or paid provider flows, including itch.io.
- Generic Lemon site inspection, because its `robots.txt` disallows crawling;
  approved APIs or exports are required.
- General upstream update checks beyond provider-supplied version markers.

Never imply any of these are present to an end user until they are implemented
and tested.

## Cross-platform rules

The application targets Linux, Windows, macOS, and ARM64 Linux, and this must be
actively maintained rather than assumed.

- **Never use `#[cfg]` where a runtime parameter will do.** Platform rules in
  `devices.rs` are pure functions that take the operating system as an argument
  (`is_protected_location`, `classify_mount`, `is_filesystem_root`), so the
  Windows and macOS behaviour is unit-tested from a Linux build host. Code
  behind `#[cfg(target_os = "windows")]` is never compiled here and its
  mistakes would ship unnoticed.
- **Canonicalisation on Windows returns `\\?\`-prefixed verbatim paths**, which
  compare unequal to the `C:\` form `sysinfo` reports for mount points. Always
  go through `paths::canonical` or `paths::strip_verbatim`; a raw
  `canonicalize()` silently breaks free-space lookups and mount matching.
- **Never read `HOME` or `XDG_*` directly.** All cache locations come from
  Tauri's `app_cache_dir`, which resolves correctly on each platform and inside
  sandboxed installations.
- **Read-only metadata is not a writability test.** The Unix permission bits
  describe the owner rather than this process, and the Windows read-only
  attribute is meaningless for directories. `devices::probe_writable` creates and
  removes one empty file, which is the only portable answer.
- **Destination-relative paths are always `/`-separated.** `safe_relative_path`
  rejects backslashes so one plan means exactly the same thing on every
  platform. The frontend normalises with `paths.ts` before sending.
- **Filesystem commands are `async` and use `task::blocking`.** A synchronous
  `#[tauri::command]` runs on the main thread and would freeze the window during
  a large scan or a SHA-256 pass over a slow stick.

## Essential safety rules

This app is expected to work with real removable devices. Treat all write paths
as high-risk.

1. Discovery and planning are read-only by default.
2. Do not identify a device only by mount path. Show device node, model/vendor/
   serial where possible, filesystem, capacity, and partition layout.
3. Never auto-format, auto-write, or use the first removable device found.
4. Before a destructive action, show a deterministic plan: target identity, all
   partitions/filesystems affected, source, estimated bytes, and exact
   operations.
5. Require an explicit final confirmation tied to the exact target. A simple
   modal "OK" is insufficient for formatting.
6. Re-resolve and re-check device identity immediately before writing so a
   removed and reinserted USB stick cannot be mistaken for the previous target.
7. Ensure the target is not the root/system disk and reject unsafe targets.
8. Prefer native Rust filesystem APIs. If external tools such as `dd`, `mkfs`,
   `udisksctl`, `mtools`, or image utilities are needed, invoke them with fixed
   argument arrays, never an interpolated shell command.
9. Report partial failures and do not claim a device is valid until a post-write
   verification completes.

## Testing

```bash
npm run verify          # build + frontend checks + native tests
npm run build           # tsc -b && vite build
npm run check           # frontend checks
npm run check:native    # cargo test
npm run screenshots     # re-capture the in-app help images
```

- **111 Rust tests.** Path safety and traversal, short-read-safe comparison,
  Windows verbatim prefixes, per-platform protected locations and mount
  classification, GVFS discovery, firmware evidence, writability probing,
  planning (additions, identical content, case-insensitive collisions, duplicate
  destinations, Keep/Remove, missing sources, staged moves, move/copy clashes,
  symlink escapes, system destinations), verified copying with and without
  checksums, ZIP extraction and caching, cache accounting and LRU eviction,
  robots parsing, Archive metadata and URL construction, JSON feed validation,
  HTTPS enforcement, device parsing on all three platforms, MBR construction and
  location, partition-window clamping, image create/populate/list/extract
  round-trips, provisioning confirmation phrases and raw-write verification, and
  the database round trip including a five-thousand-title library. One
  `#[ignore]`d test reaches a live site.
- **48 frontend checks** in [scripts/checks.ts](scripts/checks.ts), run through
  the esbuild that already ships with Vite so the project gains a test story
  without a new dependency. They cover path handling on both separator styles,
  classification and naming, firmware compatibility, the workspace reducer, the
  pre-2.0 migration, corrupt-store recovery, the format model, plan summarising,
  custom folder templates, display aliases, the native-store conversion, and two
  headless renders of the whole application.

### Screenshots

`npm run screenshots` captures the in-app help images for both palettes. It is
not a mock-up: `src/dev/captureHarness.ts` seeds a known workspace, then clicks
the real controls against fixture folders through the real native commands while
`scripts/capture-server.py` photographs the window. The application blocks on
each capture request, so the images are always in step with the interface.

The harness is inert unless `VITE_CAPTURE` is set during `npm run dev`, and
`import.meta.env.DEV` is statically false in a production build, so none of it
reaches a packaged application. Set `VITE_CAPTURE_HELP=1` and `CAPTURE_OUT_DIR`
to photograph the help page itself when reviewing a change to it.

On this machine the capture must run under XWayland (`GDK_BACKEND=x11`, which
the script sets) because GNOME's Wayland session does not permit capturing
another window. The script also strips the Snap wrapper environment that the
Snap-packaged VS Code exports, without which any native GTK/WebKit launch fails
with a libc symbol error.

When adding a platform rule, add it as a pure function with the operating system
as a parameter and test every branch. When adding a native command, decide first
whether it can fail on a destination that has been unplugged, and report that
rather than throwing.

## Local development

### Prerequisites

- Node.js 20+ and npm.
- Rust stable, normally available after `source "$HOME/.cargo/env"`.
- Tauri Linux prerequisites on Ubuntu/Debian:

  ```bash
  sudo apt-get install -y libwebkit2gtk-4.1-dev libsoup-3.0-dev \
    libayatana-appindicator3-dev librsvg2-dev
  ```

The current machine can compile and package the native application.

**VS Code is Snap-packaged, and its terminal exports a wrapper environment that
breaks native launches in two separate ways.** Both must be dealt with, and the
second is easy to miss because the application still starts:

1. `LD_LIBRARY_PATH`, `GTK_PATH`, `GIO_MODULE_DIR`, `GSETTINGS_SCHEMA_DIR`,
   `LOCPATH`, and the `SNAP_*` variables make any GTK/WebKit launch fail
   immediately with an `undefined symbol: __libc_pthread_init` error. Unset them.
2. `XDG_DATA_HOME` is redirected to `~/snap/code/<revision>/.local/share`, so an
   application launched from that terminal silently reads and writes a *different*
   data directory from the one it uses when launched normally. The window opens
   and looks fine, but the workspace appears empty because the real store is at
   `~/.local/share/uk.co.gotekmanager.desktop/`. Unset `XDG_DATA_HOME` (and
   `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`) when launching for a
   real test.

`scripts/capture-screenshots.sh` deals with both, and additionally points
`XDG_DATA_HOME` at a throwaway directory so a capture can never read or modify a
real library.

### Commands

```bash
npm install
npm run verify
PATH="$HOME/.cargo/bin:$PATH" npm run tauri dev
npm run package:linux
```

- `npm run tauri dev` starts Vite on port 1420 and runs the Rust application.
- `npm run package:linux` generates `.deb`, `.rpm`, and AppImage artifacts under
  `src-tauri/target/release/bundle/`.
- `gotek-manager` is the fixed native executable name on every platform.
- A Debian/Ubuntu build host needs the `rpm` package before it can create the
  RPM artifact; the CI workflow installs it automatically.
- Windows installers must be built on Windows (`npm run package:windows`) and
  macOS bundles on macOS (`npm run package:macos`).
- `.github/workflows/package.yml` packages every supported format on native
  GitHub-hosted runners. It uploads artifacts but deliberately does not publish a
  release or sign/notarise binaries.
- If Tauri cannot find Cargo, the `PATH=...` prefix above is required here.
- If port 1420 is occupied by an abandoned Vite process, stop only the process
  demonstrably from this project. Do not kill broad process groups.

The browser version at `http://127.0.0.1:1420` renders the shell but every
native call refuses with a "desktop application" message, so it does not prove
Tauri-native behaviour.

## Tools and dependencies

- `npm` for frontend dependencies and builds; esbuild (already a Vite
  dependency) runs the frontend checks.
- Rustup/Cargo for the Tauri backend.
- Tauri 2 and plugins: API, dialog, filesystem, opener.
- React, TypeScript, Vite, and Lucide React icons.
- Rust crates: `fatfs`, `reqwest` (rustls), `scraper`, `sha2`, `sysinfo`, `zip`,
  `serde`, `tokio`.

No new dependency was needed for the current feature set. Prefer keeping it that
way; the small, auditable dependency tree is part of why the write paths are
reviewable.

## Recommended implementation order

The original seven-step order has been worked through. What each step delivered,
and what honestly remains:

### 1. Transactional storage — done

SQLite with a versioned schema, one transaction per save, and a migration from
`localStorage` and from the pre-2.0 layout. Still to do: per-action granular
writes instead of replacing the workspace wholesale, and populating the
`sha256`, `scanned_at`, and `indexed_at` columns that already exist. Native drag
and drop from outside the application is still missing, as is virtualising the
library table, which will matter well before the database does.

### 2. Domain model — done

`Profile`, `MediaItem`, `TransferPlan`, `PhysicalDevice`, `ProvisionPlan`, and
the provider cache entry all exist. `FirmwareProfile` now carries a real format
list, which is what made the platform-and-firmware intersection possible.
Remaining: USB layout conventions and per-firmware OLED naming rules beyond a
single display width.

### 3. Transfer planner — done

Custom folder templates with `{platform}`, `{family}`, `{initial}`, and
`{format}`; display aliases held as a separate field so an original filename is
never destroyed; and optional per-profile checksum verification.

### 4. Device inventory and provisioning — done, but unproven on hardware

See "Physical devices" and "Images and provisioning" above. The logic is tested;
the physical write is not. Windows raw writing is deliberately refused.

### 5. Media and image support — partly done

Creating, populating, reading, and unpacking FAT images all work, for both
partitioned and bare layouts. `.hfe` conversion is deliberately not attempted;
see the list of what is not implemented.

### 6. Provider architecture — done

Cache accounting, LRU eviction with user-visible limits, digests recorded and
re-checked on reuse, and catalogues kept out of eviction so coverage still works
offline. Remaining: a configurable refresh policy expressed as a TTL rather than
a manual refresh.

### 7. Testing and release — ongoing

111 native tests and 48 frontend checks, including a mock-free device layer
tested through fixtures. Remaining: interaction tests for the guided flow, and
signing, notarisation, and release publication once credentials exist.

## Known gaps and things to verify

- `scripts/` is not covered by `tsc` because `@types/node` is not installed. The
  checks are still executed, so a type error there surfaces as a failure rather
  than silently passing.
- The help screenshots are captured on Linux. If a screen changes, re-run
  `npm run screenshots`; nothing warns you that they have drifted.
- The platform and firmware format lists were verified against the FlashFloppy
  and HxC documentation (linked in `src/domain/catalog.ts`) but not against
  physical hardware. Treat them as good guidance, not a guarantee.

## Repository map

```text
.
├── AI.md                          # this handover
├── README.md                      # developer overview
├── package.json                   # scripts and dependencies
├── scripts/
│   ├── checks.ts                  # frontend checks (npm run check)
│   ├── environment.ts             # browser globals for the checks
│   ├── capture-screenshots.sh     # npm run screenshots
│   └── capture-server.py          # screenshot endpoint for the harness
├── public/help/{light,dark}/      # generated screenshots, both palettes
├── src/
│   ├── main.tsx                   # React entry point
│   ├── App.tsx                    # shell: navigation, theme, dialogs
│   ├── styles.css                 # application styling
│   ├── domain/                    # pure rules, no I/O
│   │   ├── catalog.ts             # platforms, firmware, lookups
│   │   ├── media.ts               # classification, naming, operations
│   │   ├── plan.ts                # reading a transfer plan
│   │   ├── paths.ts               # native, relative, and image paths
│   │   ├── providers.ts           # built-in online providers
│   │   ├── records.ts             # immutable collection helpers
│   │   └── types.ts               # the domain model
│   ├── state/
│   │   ├── workspace.ts           # the workspace reducer
│   │   ├── useWorkspace.ts        # reducer + persistence wiring
│   │   ├── persistence.native.ts  # the database, and migration into it
│   │   ├── persistence.ts         # local storage, for small preferences
│   │   └── migrations.ts          # storage keys and the pre-2.0 migration
│   ├── dev/captureHarness.ts      # screenshot harness, dev-only
│   ├── native/
│   │   ├── commands.ts            # the only Tauri import
│   │   └── store.ts               # typed access to the database
│   ├── hooks/                     # async actions, browsing, planning
│   ├── components/                # reusable UI
│   └── pages/
│       ├── flow/                  # the six guided steps
│       ├── ProfilesPage.tsx
│       ├── DevicesPage.tsx        # devices and destructive provisioning
│       ├── helpScreens.ts         # the screens the help illustrates
│       └── HelpPage.tsx
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/default.json  # Tauri permissions
    └── src/                       # see the backend table above
```

## Notes for the next AI

- The working directory resolves through an `ownCloud` path even when the
  user-facing workspace path is
  `/home/pclarke/Projects/Personal Projects/Utilities/GoTekManager`. Treat them
  as the same working tree.
- Run `npm run verify` before and after a change. It is fast.
- The user has asked for DRY, well-factored code and genuinely cross-platform
  behaviour. Do not add another two-thousand-line file, and do not add a
  Linux-only assumption to shared code.
- Do not modify or format any storage device while developing. Use temporary
  directories and fixture files; every existing test does.
