fn main() {
    // The plugin version bundled with this app comes from the plugin's buildspec,
    // so the installer never disagrees with what the plugin reports about itself.
    let buildspec = "../obs-plugin/buildspec.json";
    println!("cargo:rerun-if-changed={buildspec}");
    let spec: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(buildspec).expect("read buildspec.json")).expect("parse buildspec.json");
    let version = spec["version"].as_str().expect("buildspec.json has a version");
    println!("cargo:rustc-env=SOUNDCHECK_PLUGIN_VERSION={version}");

    tauri_build::build()
}
