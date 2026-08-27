// Prevents a second console window on Windows in release, do not remove.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gotek_manager_lib::run();
}
