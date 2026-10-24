mod i18n;
mod loudness;
mod obs_config;
mod presence;
mod plugin_install;
mod profiles;
mod slobs;
mod sound_test;
mod streamlabs_plugin;
mod stream_tap;
mod system_audio;
mod updates;
mod voice_analysis;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered first, so a second start hands over to the running app before anything else
        // starts: two copies would both drive the streaming software and the plugin.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(sound_test::SoundTestState::default())
        .manage(stream_tap::StreamTapState::default())
        .manage(slobs::Slobs::default())
        .setup(|app| {
            profiles::migrate_from_old_identifier(app.handle());
            presence::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            i18n::set_language,
            slobs::slobs_connect,
            slobs::slobs_send,
            slobs::slobs_disconnect,
            slobs::launch_streamlabs,
            obs_config::read_obs_websocket_config,
            plugin_install::plugin_status,
            plugin_install::install_plugin,
            plugin_install::install_plugin_elevated,
            plugin_install::uninstall_plugin,
            plugin_install::uninstall_plugin_elevated,
            plugin_install::launch_obs,
            plugin_install::log_install_event,
            streamlabs_plugin::streamlabs_plugin_status,
            streamlabs_plugin::install_streamlabs_plugin,
            streamlabs_plugin::uninstall_streamlabs_plugin,
            streamlabs_plugin::streamlabs_plugin_request,
            profiles::profiles_list,
            profiles::profile_save,
            profiles::profile_load,
            profiles::profile_delete,
            stream_tap::stream_tap_start,
            stream_tap::stream_tap_stop,
            sound_test::sound_test_record,
            sound_test::sound_test_stop_recording,
            sound_test::sound_test_play,
            sound_test::sound_test_stop_playback,
            system_audio::system_audio_snapshot,
            system_audio::device_listen_start,
            system_audio::device_listen_stop,
            updates::can_install_updates,
            voice_analysis::voice_analyze,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
