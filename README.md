# obs-audio-kit

跨平台的視覺化 OBS 聲音設定工具，給不熟 OBS 的實況主用。OBS 的設定項目太多、太分散，這個工具只處理聲音。

## 要解決的問題

1. **不知道音量該怎麼調**：OBS 只給一根推桿和 dB 數字，使用者不知道多少才算剛好、太小或爆音。
2. **不知道觀眾聽到多大聲**：使用者看不到實況實際送出去的聲音有多大聲。
3. **監聽聽到的和實況送出的不一樣**：使用者用耳機監聽，以為觀眾聽到的也是這樣，其實不是。
4. **電腦有聲音，卻不知道怎麼加進 OBS**：不知道要新增哪一種音訊來源，也不知道要選哪個裝置或應用程式；甚至不知道是哪個應用程式在出聲。
5. **不清楚每個場景有哪些聲音**：使用者不知道目前在哪個場景、切換場景後哪些聲音會出現或消失。
6. **濾鏡難懂又難設定**：OBS 的濾鏡介面不直覺，而且很多人不知道噪音閘、壓縮器這些濾鏡是做什麼用的。
7. **第一次連線門檻高**：要先在 OBS 開啟 WebSocket 伺服器，再填 IP、連接埠和密碼，新手常常卡在這一步。

## 功能目標

| 功能 | 解決的問題 |
|---|---|
| **連線引導**：主要情境是 OBS 和本工具在同一台電腦。自動讀取本機 OBS 的 WebSocket 設定（連接埠、密碼）直接連線，使用者只要在 OBS 開啟 WebSocket 伺服器；讀不到時才一步一步教使用者手動設定 | 7 |
| **音訊來源總覽**：列出所有場景裡的音訊來源和即時音量表，並標出每個來源在目前場景是否真的有在使用（見下方「來源狀態」）；音量表上標出建議範圍（太小／剛好／太大） | 1、5 |
| **實況輸出音量表**：另外顯示「觀眾聽到的」總音量，和「你耳機聽到的」分開標示 | 2、3 |
| **試音**：像一般軟體的麥克風測試，錄一段 OBS 真正送去直播的混音（不是各來源分別監聽），再播放給使用者聽。不分是否在直播；播放期間觀眾暫時聽不到聲音。透過本工具內附的 OBS 外掛實現，一鍵安裝 | 2、3 |
| **直播響度**：用外掛取得的真實直播混音算出音量和響度 | 2 |
| **監聽設定**：一鍵切換監聽模式，並用白話說明每種模式會讓誰聽到 | 3 |
| **場景**：顯示目前場景、切換場景；切換後來源狀態立即更新。只顯示聲音，不調整場景本身 | 5 |
| **系統聲音偵測**：列出電腦上正在出聲的應用程式和音訊裝置（含音量），標出哪些還沒加進 OBS，一鍵加入 | 4 |
| **新增音訊來源精靈**：用「你想加入什麼聲音？」（麥克風、整個電腦的聲音、某個應用程式）引導選擇，不讓使用者面對 OBS 的來源類型名稱 | 4 |
| **濾鏡精靈**：用「你遇到什麼問題？」（背景有雜音、音量忽大忽小、怕爆音）推薦濾鏡，每個濾鏡都附白話說明，參數用視覺化方式調整 | 6 |
| **快速調整**：音量、靜音、聲道平衡、同步偏移 | 1 |
| **設定檔**：儲存和載入整套聲音設定 | — |

### 來源狀態

OBS 的音量和濾鏡屬於音訊來源本身，不屬於場景；同一個來源放在多個場景時，設定是共用的。所以這個工具不做「每個場景各自的音量」，而是抓出所有場景用到的音訊來源，告訴使用者每個來源在**目前場景**的狀態：

| 狀態 | 意思 | 判斷方式 |
|---|---|---|
| 觀眾聽得到 | 在目前場景、沒有隱藏、沒有靜音、有送到直播音軌 | 以下條件都不成立 |
| 不在這個場景 | 只出現在其他場景，切過去才會有聲音 | 目前場景（含巢狀場景和群組）裡找不到它 |
| 已隱藏 | 在目前場景，但項目被隱藏（眼睛關掉），聲音不會送出 | 場景項目 `sceneItemEnabled` 為 false |
| 已靜音 | 在目前場景，但被靜音 | `GetInputMute` |
| 沒送到直播 | 在目前場景，但沒有勾選直播用的音軌，只有錄影聽得到 | `GetInputAudioTracks` 對照直播使用的音軌 |
| 全域 | OBS 設定裡加的桌面音訊／麥克風，每個場景都有 | `GetSpecialInputs` |

「觀眾聽得到」的來源再依音量表分成「正在出聲」和「目前沒聲音」，讓使用者一眼看出是不是有該出聲卻沒聲音的來源。

## 直播監聽（OBS 外掛）

obs-websocket 拿不到 OBS 混好的直播聲音，所以需要一個小型 OBS 外掛（`obs-plugin/`，C++，沿用 obs-live-translate 的建置方式）。外掛只負責「接出聲音」，播放和分析都在本工具裡做：

```
OBS 混音器 ──(直播用的音軌)──▶ 外掛 ──本機連線──▶ obs-audio-kit ──▶ 耳機
                                                    └─▶ 直播音量表、響度
```

- **接出聲音**：外掛用 libobs 的 `obs_add_raw_audio_callback(mix_idx, …)` 取得指定音軌的混音 PCM。
- **知道直播用哪條音軌**：外掛用 `obs_frontend_get_streaming_output()` + `obs_output_get_mixers()` 直接問 OBS，不用猜簡易／進階模式的設定。
- **控制**：外掛向 obs-websocket 註冊 vendor requests（`obs_websocket_register_vendor`），本工具用既有的 WebSocket 連線開關監聽、查詢音軌。
- **傳送聲音**：PCM 走本機 socket 送給本工具，不走 WebSocket（JSON 太重）。
- **播放**：本工具的 Rust 端播放到使用者選的耳機。

外掛只「讀」音軌，不新增音軌、來源或濾鏡，也不會把任何聲音放回 OBS 的混音。唯一會改動 OBS 設定的是試音：播放期間暫時取消勾選直播音軌，結束後還原。外掛在 OBS 裡沒有任何介面；OBS 啟動時自動載入，平常不做事，只有本工具要求時才接出聲音。

### 試音

做法和一般軟體的麥克風測試一樣：先錄一段，再播放。錄音和播放不會同時進行，所以不管使用者用哪個裝置聽，都不會有回音。

1. **錄音**（預設 10 秒，最長 15 秒，可提前停止）：外掛讀取直播音軌，送給本工具暫存在記憶體。直播照常進行，觀眾聽得到。錄音時同時顯示即時音量表
2. **播放**：停止讀取音軌，在本工具裡播放剛才錄的聲音，並顯示這段的音量和響度摘要（例如「整體偏小，建議把麥克風調高 3 dB」）。播放期間，把所有來源暫時從直播音軌取消勾選，讓播放的聲音即使被「桌面音訊」擷取也不會送到直播；觀眾在這段時間聽不到聲音
3. **結束**：還原每個來源原本的音軌設定

**安全機制**：如果本工具在播放中當掉或斷線，音軌沒還原，直播就會一直沒聲音。所以取消勾選和還原由外掛負責，本工具在播放期間定期發送心跳；外掛超過幾秒沒收到心跳就自動還原。OBS 關閉前也要還原。

### 一鍵安裝

外掛的二進位檔打包在本工具裡，不另外下載。安裝流程：

1. 偵測 OBS 版本和外掛資料夾
2. OBS 正在執行時，請使用者關閉 OBS（Windows 上已載入的 DLL 無法覆寫，而且外掛要重開 OBS 才會載入）
3. 複製外掛到資料夾
4. 幫使用者重新開啟 OBS，連上後用 vendor request 確認外掛已載入

| 平台 | 外掛資料夾 | 需要系統管理員權限 |
|---|---|---|
| Windows | `C:\ProgramData\obs-studio\plugins\obs-audio-kit\bin\64bit\` | 待確認 |
| macOS | `~/Library/Application Support/obs-studio/plugins/obs-audio-kit.plugin` | 不需要 |
| Linux | `~/.config/obs-studio/plugins/obs-audio-kit/bin/64bit/` | 不需要（Flatpak 版 OBS 不支援） |

### 驗證紀錄

在 Windows 11（OBS 32.2.2）上驗證過，外掛以 OBS 31.1.1 原始碼建置：

- **外掛載入**：放進 `C:\ProgramData\obs-studio\plugins\obs-audio-kit\bin\64bit\` 後重開 OBS 即可載入，log 有 `[obs-audio-kit] module loaded`
- **OBS 32 外掛管理員**：新外掛自動加入 `plugin_manager\modules.json`，預設 `enabled=true`，使用者不需要手動啟用
- **接出直播音軌**：`StartTap` 接出音軌 1，15 秒收到 15.00 秒音訊（實際耗時 15.01–15.02 秒），沒有掉資料；錄到的峰值和 OBS 自己的音量表一致（-14.8 dBFS 對 -14.8 dBFS）
- **直播用哪條音軌**：沒在直播時，從進階模式的設定（`AdvOut` / `TrackIndex`）正確讀到音軌 1
- **自動連線**：讀取 `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json` 的連接埠和密碼就能連上 obs-websocket 5.7.4，不需要使用者輸入
- **試音播放時暫停直播聲音**（`pause-test.mjs`，8 項全部通過）：暫停時 21 個音訊來源全部離開直播音軌，其他音軌不受影響；重複暫停會被拒絕；有心跳時維持暫停；心跳停止後外掛在逾時（2 秒）後自動還原；明確還原也會立即恢復。測試前後每個來源的音軌設定完全相同
- **試音功能（App）**：使用者在 Windows 上實際操作錄音、看結果、播放，聲音正常
- **Windows 資料夾權限**：`C:\ProgramData\obs-studio\plugins` 的 ACL 讓一般使用者可以新建資料夾，且對自己建的資料夾有完整權限，推論全新安裝不需要 UAC。但如果資料夾是用提權方式建的（擁有者變成 Administrators），之後一般權限就無法更新或刪除，所以**安裝程式必須一律用一般權限安裝**，不能有時提權有時不提權

### 待驗證

- 直播中時，從直播輸出的 mixer mask 讀取直播音軌（`streamTracksOrigin: "output"`）
- 簡易輸出模式下的直播音軌判斷
- 一般權限（非提權）的程式實際寫入 `C:\ProgramData\obs-studio\plugins` 是否成功（目前只從 ACL 推論）
- macOS 上未簽章的外掛能否載入、複製後是否要移除 quarantine 屬性
- 最低支援的 OBS 版本（較新版本建置的外掛，舊版 OBS 不會載入，所以要用最低支援版本建置）
- 播放期間取消勾選、再還原音軌時，直播中的觀眾端是否會有爆音或短暫斷音（目前只在沒直播時測過）
- 試音結果的判斷門檻（偏小 < -24 LUFS、偏大 > -10 LUFS，以 YouTube 的 -14 LUFS 為參考）目前是暫定值，要用更多實際錄音調整
- **已知風險**：暫停期間如果 OBS 剛好自動儲存場景集合，又在幾秒內當掉，下次開 OBS 時部分來源可能仍未勾選直播音軌。正常關閉 OBS 或 App 都會先還原

## 技術架構

- **桌面框架**：Tauri 2 + React + TypeScript + Vite（與 noalbsgui 相同）
- **連線 OBS**：前端用 `obs-websocket-js` 直接連 obs-websocket v5（OBS 28 以後內建）
  - 設定：`SetInputVolume`、`SetInputMute`、`SetInputAudioBalance`、`SetInputAudioSyncOffset`
  - 監聽：`SetInputAudioMonitorType`
  - 濾鏡：`CreateSourceFilter`、`SetSourceFilterSettings`
  - 即時音量表：訂閱 `InputVolumeMeters` 事件
  - 場景：`GetSceneList`、`SetCurrentProgramScene`、`GetSceneItemList`、`GetGroupSceneItemList`（巢狀場景和群組要遞迴展開），訂閱 `CurrentProgramSceneChanged`、`SceneItemEnableStateChanged`
  - 來源狀態：`GetSpecialInputs`、`GetInputMute`、`GetInputAudioTracks`
  - 新增來源：`GetInputKindList`、`CreateInput`，裝置清單用 `GetInputPropertiesListPropertyItems`
- **支援平台**：Windows / macOS / Linux

## 開發

需要 Node.js 22 以上和 Rust（stable）。

```sh
npm install
npm run tauri dev     # 開發模式，啟動桌面視窗
npm run tauri build   # 打包安裝檔
```

目前介面使用假資料（`src/mock.ts`），還沒有連到 OBS。
