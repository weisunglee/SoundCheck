//! Messages the backend shows to the user, in the language the UI picked (see `src/i18n.tsx`).
//! Each row is one message: Traditional Chinese (the text used in code), Simplified Chinese,
//! English, Japanese, Korean. `{name}` placeholders are filled by [`trf`].

use std::fmt::Display;
use std::sync::atomic::{AtomicUsize, Ordering};

const LANGS: [&str; 5] = ["zh-TW", "zh-CN", "en", "ja", "ko"];
static CURRENT: AtomicUsize = AtomicUsize::new(0);

#[rustfmt::skip]
const MESSAGES: &[[&str; 5]] = &[
    ["無法建立設定檔資料夾：{e}", "无法创建配置文件夹：{e}", "Couldn't create the profiles folder: {e}", "プロファイルのフォルダーを作成できません：{e}", "프로필 폴더를 만들 수 없습니다: {e}"],
    ["設定檔名稱不能是空的", "配置名称不能为空", "The profile name can't be empty.", "プロファイル名を入力してください。", "프로필 이름을 입력하세요."],
    ["儲存設定檔失敗：{e}", "保存配置失败：{e}", "Couldn't save the profile: {e}", "プロファイルを保存できません：{e}", "프로필을 저장할 수 없습니다: {e}"],
    ["讀取設定檔失敗：{e}", "读取配置失败：{e}", "Couldn't read the profile: {e}", "プロファイルを読み込めません：{e}", "프로필을 읽을 수 없습니다: {e}"],
    ["設定檔格式不對：{e}", "配置格式不正确：{e}", "The profile file is not valid: {e}", "プロファイルの形式が正しくありません：{e}", "프로필 형식이 올바르지 않습니다: {e}"],
    ["刪除設定檔失敗：{e}", "删除配置失败：{e}", "Couldn't delete the profile: {e}", "プロファイルを削除できません：{e}", "프로필을 삭제할 수 없습니다: {e}"],
    ["無法讀取 {path}：{e}", "无法读取 {path}：{e}", "Couldn't read {path}: {e}", "{path} を読み込めません：{e}", "{path}을(를) 읽을 수 없습니다: {e}"],
    ["直播軟體的 WebSocket 設定格式不符：{e}", "直播软件的 WebSocket 设置格式不符：{e}", "The streaming software's WebSocket settings file is not valid: {e}", "配信ソフトの WebSocket 設定ファイルの形式が正しくありません：{e}", "방송 프로그램의 WebSocket 설정 파일 형식이 올바르지 않습니다: {e}"],
    ["還沒有錄音", "还没有录音", "Nothing has been recorded yet.", "まだ録音していません。", "아직 녹음하지 않았습니다."],
    ["找不到播放裝置", "找不到播放设备", "No playback device found.", "再生デバイスが見つかりません。", "재생 장치를 찾을 수 없습니다."],
    ["不支援的播放格式：{format}", "不支持的播放格式：{format}", "Unsupported playback format: {format}", "対応していない再生形式です：{format}", "지원하지 않는 재생 형식입니다: {format}"],
    ["安裝後的外掛版本是 {found}，不是預期的 {expected}。", "安装后的插件版本是 {found}，不是预期的 {expected}。", "The installed plugin is version {found}, not the expected {expected}.", "インストールされたプラグインのバージョンは {found} で、想定の {expected} ではありません。", "설치된 플러그인 버전이 예상한 {expected}이(가) 아니라 {found}입니다."],
    ["直播軟體正在使用舊版外掛。請先關閉直播軟體再安裝。", "直播软件正在使用旧版插件。请先关闭直播软件再安装。", "The streaming software is using the old plugin. Close it before installing.", "配信ソフトが古いプラグインを使用中です。配信ソフトを閉じてからインストールしてください。", "방송 프로그램이 이전 플러그인을 사용 중입니다. 방송 프로그램을 닫은 뒤 설치하세요."],
    ["已取消系統管理員權限的移除。", "已取消系统管理员权限的移除。", "Removing with administrator rights was cancelled.", "管理者権限での削除はキャンセルされました。", "관리자 권한으로 제거하는 작업이 취소되었습니다."],
    ["沒有權限移除外掛。這通常是因為之前用系統管理員權限安裝過外掛。", "没有权限移除插件。这通常是因为之前用系统管理员权限安装过插件。", "No permission to remove the plugin. This usually means it was installed with administrator rights before.", "プラグインを削除する権限がありません。以前に管理者権限でインストールしたことが原因であることが多いです。", "플러그인을 제거할 권한이 없습니다. 보통 이전에 관리자 권한으로 플러그인을 설치했기 때문입니다."],
    ["直播軟體正在使用外掛。請先關閉直播軟體再移除。", "直播软件正在使用插件。请先关闭直播软件再移除。", "The streaming software is using the plugin. Close it before removing.", "配信ソフトがプラグインを使用中です。配信ソフトを閉じてから削除してください。", "방송 프로그램이 플러그인을 사용 중입니다. 방송 프로그램을 닫은 뒤 제거하세요."],
    ["直播軟體還開著。請先關閉它再移除。", "直播软件还开着。请先关闭它再移除。", "The streaming software is still running. Close it before removing.", "配信ソフトが起動したままです。閉じてから削除してください。", "방송 프로그램이 아직 실행 중입니다. 닫은 뒤 제거하세요."],
    ["移除外掛失敗：{e}", "移除插件失败：{e}", "Couldn't remove the plugin: {e}", "プラグインを削除できませんでした：{e}", "플러그인을 제거하지 못했습니다: {e}"],
    ["移除後外掛資料夾還在。", "移除后插件文件夹还在。", "The plugin folder is still there after removing.", "削除後もプラグインのフォルダーが残っています。", "제거한 뒤에도 플러그인 폴더가 남아 있습니다."],
    ["直播軟體還開著。請先關閉它再安裝。", "直播软件还开着。请先关闭它再安装。", "The streaming software is still running. Close it before installing.", "配信ソフトが起動したままです。閉じてからインストールしてください。", "방송 프로그램이 아직 실행 중입니다. 닫은 뒤 설치하세요."],
    ["這個版本的 App 沒有附外掛。", "这个版本的 App 没有附带插件。", "This build of the app doesn't include the plugin.", "このバージョンのアプリにはプラグインが含まれていません。", "이 버전의 앱에는 플러그인이 포함되어 있지 않습니다."],
    ["找不到直播軟體的外掛資料夾。", "找不到直播软件的插件文件夹。", "Couldn't find the streaming software's plugin folder.", "配信ソフトのプラグインフォルダーが見つかりません。", "방송 프로그램의 플러그인 폴더를 찾을 수 없습니다."],
    ["沒有權限寫入外掛資料夾。這通常是因為之前用系統管理員權限安裝過外掛。", "没有权限写入插件文件夹。这通常是因为之前用管理员权限安装过插件。", "No permission to write to the plugin folder. This usually happens when the plugin was installed as administrator before.", "プラグインフォルダーに書き込む権限がありません。以前に管理者権限でプラグインをインストールした場合によく起こります。", "플러그인 폴더에 쓸 권한이 없습니다. 이전에 관리자 권한으로 플러그인을 설치한 경우 흔히 발생합니다."],
    ["沒有權限移除舊版外掛。這通常是因為之前用系統管理員權限安裝過外掛。", "没有权限移除旧版插件。这通常是因为之前用管理员权限安装过插件。", "No permission to remove the old plugin. This usually happens when it was installed as administrator.", "旧バージョンのプラグインを削除する権限がありません。以前に管理者権限でインストールした場合によく起こります。", "이전 플러그인을 제거할 권한이 없습니다. 이전에 관리자 권한으로 설치한 경우 흔히 발생합니다."],
    ["複製外掛失敗：{e}", "复制插件失败：{e}", "Couldn't copy the plugin: {e}", "プラグインをコピーできません：{e}", "플러그인을 복사할 수 없습니다: {e}"],
    ["外掛路徑不正確", "插件路径不正确", "The plugin path is not valid.", "プラグインのパスが正しくありません。", "플러그인 경로가 올바르지 않습니다."],
    ["已取消系統管理員權限的安裝。", "已取消管理员权限的安装。", "The administrator install was cancelled.", "管理者権限でのインストールはキャンセルされました。", "관리자 권한 설치가 취소되었습니다."],
    ["安裝後找不到外掛檔案。", "安装后找不到插件文件。", "The plugin file is missing after installing.", "インストール後にプラグインのファイルが見つかりません。", "설치 후 플러그인 파일을 찾을 수 없습니다."],
    ["只有 Windows 需要系統管理員權限安裝。", "只有 Windows 需要管理员权限安装。", "Only Windows needs an administrator install.", "管理者権限でのインストールが必要なのは Windows だけです。", "관리자 권한 설치는 Windows에서만 필요합니다."],
    ["無法開啟直播軟體：{e}", "无法打开直播软件：{e}", "Couldn't open the streaming software: {e}", "配信ソフトを起動できません：{e}", "방송 프로그램을 열 수 없습니다: {e}"],
    ["無法連到 Streamlabs：{e}", "无法连接到 Streamlabs：{e}", "Couldn't connect to Streamlabs: {e}", "Streamlabs に接続できません：{e}", "Streamlabs에 연결할 수 없습니다: {e}"],
    ["無法連到直播軟體的外掛：{e}", "无法连接到直播软件的插件：{e}", "Couldn't connect to the streaming software's plugin: {e}", "配信ソフトのプラグインに接続できません：{e}", "방송 프로그램의 플러그인에 연결할 수 없습니다: {e}"],
    ["還沒接上直播的聲音，請確認直播軟體的外掛已經載入。", "还没接上直播的声音，请确认直播软件的插件已经加载。", "Not connected to the stream audio yet. Check that the streaming software has loaded the plugin.", "まだ配信の音声に接続していません。配信ソフトがプラグインを読み込んでいるか確認してください。", "아직 방송 오디오에 연결되지 않았습니다. 방송 프로그램이 플러그인을 로드했는지 확인하세요."],
    ["已經在錄音了", "已经在录音了", "Already recording.", "すでに録音中です。", "이미 녹음 중입니다."],
    ["錄音時沒有收到聲音，和外掛的連線可能中斷了。", "录音时没有收到声音，和插件的连接可能中断了。", "No audio arrived while recording. The connection to the plugin may have dropped.", "録音中に音声が届きませんでした。プラグインとの接続が切れた可能性があります。", "녹음 중에 오디오가 들어오지 않았습니다. 플러그인과의 연결이 끊겼을 수 있습니다."],
    ["這個平台不能從這裡開啟直播軟體。", "这个平台不能从这里打开直播软件。", "The streaming software can't be opened from here on this platform.", "このプラットフォームではここから配信ソフトを起動できません。", "이 플랫폼에서는 여기서 방송 프로그램을 열 수 없습니다."],
    ["這個平台還不支援試聽音量", "这个平台还不支持试听音量", "Level preview isn't supported on this platform yet.", "このプラットフォームではまだ音量の試聴に対応していません。", "이 플랫폼에서는 아직 음량 미리 듣기를 지원하지 않습니다."],
    ["試聽失敗", "试听失败", "The level preview failed.", "試聴できませんでした。", "미리 듣기에 실패했습니다."],
    ["無法開啟這個裝置：{e}", "无法打开这个设备：{e}", "Couldn't open this device: {e}", "このデバイスを開けません：{e}", "이 장치를 열 수 없습니다: {e}"],
    ["讀取系統聲音失敗：{e}", "读取系统声音失败：{e}", "Couldn't read the system audio: {e}", "システムの音声を読み込めません：{e}", "시스템 오디오를 읽을 수 없습니다: {e}"],
];

/// Remembers the UI language for messages created after this call.
#[tauri::command]
pub fn set_language(lang: String) {
    if let Some(i) = LANGS.iter().position(|l| *l == lang) {
        CURRENT.store(i, Ordering::Relaxed);
    }
}

/// `text` (Traditional Chinese) in the current language; unknown texts come back unchanged.
pub fn tr(text: &str) -> String {
    let lang = CURRENT.load(Ordering::Relaxed);
    MESSAGES.iter().find(|row| row[0] == text).map_or(text, |row| row[lang]).to_string()
}

/// Like [`tr`], then replaces each `{name}` with its value.
pub fn trf(text: &str, args: &[(&str, &dyn Display)]) -> String {
    args.iter().fold(tr(text), |s, (name, value)| s.replace(&format!("{{{name}}}"), &value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_row_keeps_its_placeholders() {
        let names = |s: &str| {
            let mut v: Vec<String> = s.split('{').skip(1).filter_map(|p| p.split('}').next()).map(str::to_string).collect();
            v.sort();
            v
        };
        for row in MESSAGES {
            for text in &row[1..] {
                assert_eq!(names(row[0]), names(text), "placeholders differ in {text}");
            }
        }
    }
}
