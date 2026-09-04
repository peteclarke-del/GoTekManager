GoTek Manager catalogues retro-software disk images and prepares media for a
GoTek floppy emulator: it indexes your library, works out which titles a given
machine and firmware can actually load, and writes them to a stick with the
drive's own configuration alongside them.

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

Copying files to a mounted stick — which is what most people will do — verifies
every byte it writes and never overwrites in place.
