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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            plugin_install::launch_obs,
            plugin_install::log_install_event,
            streamlabs_plugin::streamlabs_plugin_status,
            streamlabs_plugin::install_streamlabs_plugin,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
