GoTek Manager catalogues retro-software disk images and prepares media for a
GoTek floppy emulator: it indexes your library, works out which titles a given
machine and firmware can actually load, and writes them to a stick with the
drive's own configuration alongside them.

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
