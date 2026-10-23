//! Saved sets of audio settings, one JSON file each in the app's config folder.
//! The app builds and applies the contents; this module only stores them.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::i18n::{tr, trf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    name: String,
    saved_at: Option<String>,
    source_count: usize,
    /// Saved automatically before another profile was applied.
    backup: bool,
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("profiles");
    std::fs::create_dir_all(&dir).map_err(|e| trf("無法建立設定檔資料夾：{e}", &[("e", &e)]))?;
    Ok(dir)
}

/// File names keep the profile name readable but drop characters Windows forbids.
fn file_for(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let stem: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let stem = stem.trim().trim_end_matches('.');
    if stem.is_empty() {
        return Err(tr("設定檔名稱不能是空的"));
    }
    Ok(dir(app)?.join(format!("{stem}.json")))
}

/// The app's identifier before it was renamed to SoundCheck; its config folder may still hold profiles.
const OLD_IDENTIFIER: &str = "io.github.weisunglee.obsaudiokit";

/// Copies profiles saved under the old identifier, once, if the new folder has none yet.
pub fn migrate_from_old_identifier(app: &AppHandle) {
    let Ok(new_dir) = dir(app) else { return };
    let Some(old_dir) = new_dir.parent().and_then(Path::parent).map(|config| config.join(OLD_IDENTIFIER).join("profiles")) else {
        return;
    };
    let already_has_profiles = std::fs::read_dir(&new_dir).map(|mut d| d.next().is_some()).unwrap_or(false);
    let Ok(old) = std::fs::read_dir(&old_dir) else { return };
    if already_has_profiles {
        return;
    }
    for entry in old.flatten() {
        let _ = std::fs::copy(entry.path(), new_dir.join(entry.file_name()));
    }
}

#[tauri::command]
pub fn profiles_list(app: AppHandle) -> Result<Vec<ProfileSummary>, String> {
    let mut list = Vec::new();
    for entry in std::fs::read_dir(dir(&app)?).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        list.push(ProfileSummary {
            name: value["name"].as_str().unwrap_or_default().to_string(),
            saved_at: value["savedAt"].as_str().map(str::to_string),
            source_count: value["sources"].as_array().map_or(0, Vec::len),
            backup: value["backup"].as_bool().unwrap_or(false),
        });
    }
    list.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(list)
}

#[tauri::command]
pub fn profile_save(app: AppHandle, name: String, data: Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(file_for(&app, &name)?, text).map_err(|e| trf("儲存設定檔失敗：{e}", &[("e", &e)]))
}

#[tauri::command]
pub fn profile_load(app: AppHandle, name: String) -> Result<Value, String> {
    let text = std::fs::read_to_string(file_for(&app, &name)?).map_err(|e| trf("讀取設定檔失敗：{e}", &[("e", &e)]))?;
    serde_json::from_str(&text).map_err(|e| trf("設定檔格式不對：{e}", &[("e", &e)]))
}

#[tauri::command]
pub fn profile_delete(app: AppHandle, name: String) -> Result<(), String> {
    std::fs::remove_file(file_for(&app, &name)?).map_err(|e| trf("刪除設定檔失敗：{e}", &[("e", &e)]))
}
