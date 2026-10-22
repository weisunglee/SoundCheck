mod loudness;
mod obs_config;
mod sound_test;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(sound_test::SoundTestState::default())
        .invoke_handler(tauri::generate_handler![
            obs_config::read_obs_websocket_config,
            sound_test::sound_test_record,
            sound_test::sound_test_stop_recording,
            sound_test::sound_test_play,
            sound_test::sound_test_stop_playback,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
