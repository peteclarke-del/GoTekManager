//! GoTek Manager native backend.
//!
//! The application is organised so that risky behaviour is easy to find and
//! easy to test:
//!
//! - [`paths`] and [`devices`] hold every rule about where a write is allowed
//!   to land, expressed as pure functions so the Windows and macOS behaviour is
//!   verified from any build host.
//! - [`transfer`] plans and applies changes. It never overwrites, always
//!   re-plans immediately before writing, and refuses any plan carrying a
//!   warning.
//! - [`online`] fetches catalogues and downloads behind one adapter interface,
//!   honouring each site's stated policy.
//!
//! Commands that touch the filesystem are `async` and hand their work to the
//! blocking pool via [`task::blocking`], so a large library scan or a slow USB
//! stick never freezes the window.

mod archive;
mod cache;
mod convert;
mod devices;
mod hardware;
mod image;
mod error;
mod fingerprint;
mod media;
mod online;
mod paths;
mod provision;
mod store;
mod task;
mod transfer;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            // Discovery and browsing: read-only.
            devices::mounted_targets,
            hardware::physical_devices,
            media::inspect_target,
            media::list_directory,
            media::list_image_directory,
            media::scan_folder,
            convert::supported_conversions,
            // Planning and writing.
            transfer::compare_target_files,
            transfer::plan_transfer,
            transfer::execute_transfer,
            // Filesystem images.
            image::image_summary,
            image::create_image,
            image::extract_image,
            // Destructive device provisioning.
            provision::plan_provision,
            provision::execute_provision,
            // Online catalogues.
            online::refresh_provider,
            online::load_provider_catalog,
            online::browse_online_title,
            online::download_online_title,
            // Persistent store.
            store::load_workspace,
            store::save_workspace,
            store::read_document,
            store::read_config_file,
            fingerprint::fingerprint_paths,
            fingerprint::prune_digests,
            store::write_document,
            cache::cache_summary,
            cache::evict_cache,
            cache::clear_download_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GoTek Manager");
}
