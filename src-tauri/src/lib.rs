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
mod source;
mod update;
mod cache;
mod convert;
mod devices;
mod hardware;
mod image;
mod error;
mod fingerprint;
mod firmware;
mod library;
mod media;
mod online;
mod paths;
mod provision;
mod store;
mod task;
#[cfg(test)]
mod testing;
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
            image::image_capacity,
            media::read_destination,
            media::scan_folder,
            convert::supported_conversions,
            firmware::firmware_config_state,
            firmware::write_firmware_config,
            // Planning and writing.
            transfer::compare_target_files,
            transfer::plan_transfer,
            transfer::execute_transfer,
            // Filesystem images.
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
            store::query_items,
            library::replace_source_items,
            library::upsert_items,
            library::forget_source,
            library::update_items,
            library::clear_library,
            library::held_titles,
            library::staged_items,
            library::stage_items,
            library::unstage_items,
            library::clear_collection,
            store::read_config_file,
            // Which version this is, and whether a newer one is published.
            update::app_version,
            update::published_releases,
            cache::cache_summary,
            cache::evict_cache,
            cache::clear_download_cache,
        ])
        .setup(|app| {
            // Housekeeping rather than startup work, so it runs on a thread of
            // its own and nothing on screen waits for it. See prune_digests for
            // why the cache is swept at all.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let _ = fingerprint::prune_digests(&handle);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running GoTek Manager");
}
