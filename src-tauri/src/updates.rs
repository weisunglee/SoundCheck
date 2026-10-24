//! Whether this copy of the app can install an update itself. The updater plugin replaces what
//! an installer put down: the NSIS or MSI install on Windows, the .app bundle on macOS. The
//! portable zip (a bare SoundCheck.exe) and a dev build have neither, so for those the UI only
//! points at the download page.

use std::path::Path;

use tauri::utils::{config::BundleType, platform};

/// `true` when the updater plugin can download and install a new version over this one.
#[tauri::command]
pub fn can_install_updates() -> bool {
    let exe = platform::current_exe().unwrap_or_default();
    self_updatable(cfg!(windows), cfg!(target_os = "macos"), platform::bundle_type(), &exe)
}

fn self_updatable(windows: bool, macos: bool, bundle: Option<BundleType>, exe: &Path) -> bool {
    if windows {
        // The bundler marks the exe it packs into each installer and leaves target/release's
        // copy (the one the portable zip carries) unmarked.
        matches!(bundle, Some(BundleType::Nsis | BundleType::Msi))
    } else if macos {
        // bundle_type() always says App on macOS, so look at where the binary runs from: the
        // updater replaces the .app around it, and a dev build has none.
        let mut parts = exe.parent().into_iter().flat_map(|dir| dir.iter().rev());
        parts.next() == Some("MacOS".as_ref())
            && parts.next() == Some("Contents".as_ref())
            && parts.next().is_some_and(|app| Path::new(app).extension() == Some("app".as_ref()))
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_installs_update_themselves_and_portable_does_not() {
        let exe = Path::new(r"C:\Program Files\SoundCheck\SoundCheck.exe");
        assert!(self_updatable(true, false, Some(BundleType::Nsis), exe));
        assert!(self_updatable(true, false, Some(BundleType::Msi), exe));
        assert!(!self_updatable(true, false, None, Path::new(r"D:\Tools\SoundCheck\SoundCheck.exe")));
    }

    #[test]
    fn macos_needs_an_app_bundle() {
        let app = Path::new("/Applications/SoundCheck.app/Contents/MacOS/SoundCheck");
        assert!(self_updatable(false, true, Some(BundleType::App), app));
        let dev = Path::new("/Users/me/SoundCheck/src-tauri/target/debug/soundcheck");
        assert!(!self_updatable(false, true, Some(BundleType::App), dev));
        let not_app = Path::new("/tmp/SoundCheck/Contents/MacOS/SoundCheck");
        assert!(!self_updatable(false, true, Some(BundleType::App), not_app));
    }
}
