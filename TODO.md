# To do

Things worth doing next, with enough of the reasoning to pick one up cold.

## Prove device provisioning against real hardware

Writing a whole device is the one path that has never been run against a real
stick. Every guard around it is tested and the copy-and-verify core is tested,
but tests are not the same as a drive that has read the result back. Until
somebody does it with a spare stick and a real machine, the release notes have
to keep saying so.

The same is true, more narrowly, of two other things that are proven against
bytes rather than against hardware: image conversion (`.msa` to `.st`, `.scl`
to `.trd`) is checked against files built from the format specifications, and
the `FF.CFG` written to a stick follows FlashFloppy's documentation rather than
a drive that has loaded it.

## Revisit the glib advisory when Tauri moves off GTK3

`.cargo/audit.toml` carries one entry, RUSTSEC-2024-0429, because nothing in the
Linux stack can take the fix: the GTK3 bindings are a finished line and the
newest wry still requires them. When Tauri moves to the GTK4/webkitgtk-6
bindings, delete the entry and let the audit job say whether it was still
needed. That file explains the reasoning; this is only the reminder to look.

## Re-run the help screenshots when a screen changes

`npm run screenshots` drives the real application against fixture folders and
writes both palettes. It is easy to forget, and the checks only notice a screen
that has been added or renamed — not one that has quietly changed appearance.
