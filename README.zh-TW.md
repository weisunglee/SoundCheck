<p align="center"><img src="src-tauri/icons/128x128.png" alt="SoundCheck" width="96"></p>

# SoundCheck

[English](README.md) | 繁體中文

給實況主用的聲音工具：開播前試音、直播中看觀眾到底聽到什麼，並用白話把直播軟體的聲音設定好。直播軟體的設定項目太多、太分散，SoundCheck 只處理聲音。

- **支援的直播軟體**：
  - **OBS Studio 28 以上**：全部功能（透過內建的 obs-websocket 連線）。
  - **Streamlabs Desktop**：透過它的本機 API（Windows 的 named pipe `\\.\pipe\slobs`、macOS 的 `slobs.sock`）連線，本機連線免 Token。可以調音量、靜音、監聽、音軌、提早延後、切換場景、顯示來源、看來源狀態、新增來源，也能用濾鏡精靈和設定檔。監聽、音軌、提早延後和濾鏡用的是 Streamlabs 沒寫在文件上的內部呼叫（它的 API 會把外部物件沒有的方法轉給內部物件），`tools/verify-streamlabs.ts` 會在實際的 Streamlabs 上逐項驗證。試音、實況輸出音量表和各來源的音量表用 SoundCheck 外掛的 Streamlabs 版（見「直播監聽」）。它沒有聲道平衡，所以左右平衡在 Streamlabs 上會自動隱藏。
  - 右上角可以選「自動偵測」（有開哪個就連哪個，兩個都開時優先 OBS）、OBS 或 Streamlabs。介面一般用「直播軟體」稱呼，只有教學步驟用 `{app}` 帶出軟體名稱。
- **介面語言**：繁體中文、简体中文、English、日本語、한국어，可在右上角切換，第一次開啟會跟著系統語言。
- **主題**：淺色、深色或跟隨系統，可在右上角切換。
- **平台**：Windows（主要測試平台）、macOS、Linux。系統聲音偵測和應用程式擷取目前只支援 Windows。

## 使用方式

到[最新的 Release](https://github.com/weisunglee/SoundCheck/releases/latest) 下載：Windows 用 `-setup.exe` 安裝檔（或用 `x64-portable.zip` 免安裝版，解壓縮後直接執行 `SoundCheck.exe`，`obs-plugin` 資料夾要跟它放在一起），macOS 用 `.dmg`（Intel 和 Apple Silicon 都能用）。安裝檔目前沒有程式碼簽章：Windows 的 SmartScreen 可能警告「不明發行者」（按「其他資訊」→「仍要執行」），macOS 第一次開啟要按右鍵 →「打開」。

1. 開啟直播軟體，在 OBS 的「工具 → WebSocket 伺服器設定」勾選「啟用 WebSocket 伺服器」。SoundCheck 會自動讀取連接埠和密碼，不用手動輸入。
2. 開啟 SoundCheck。連不上時畫面會依原因一步一步說明。
3. 想用試音和「觀眾聽到的」音量表，按右上角的「安裝外掛」。OBS 安裝時需要你自己關閉 OBS，裝好後 SoundCheck 會幫你重新開啟並確認外掛已載入；Streamlabs 第一次安裝不用重開，更新時才需要先關閉它。

## 設計說明

以下是開發時的設計和驗證紀錄。

### 要解決的問題

1. **不知道音量該怎麼調**：OBS 只給一根推桿和 dB 數字，使用者不知道多少才算剛好、太小或爆音。
2. **不知道觀眾聽到多大聲**：使用者看不到實況實際送出去的聲音有多大聲。
3. **監聽聽到的和實況送出的不一樣**：使用者用耳機監聽，以為觀眾聽到的也是這樣，其實不是。
4. **電腦有聲音，卻不知道怎麼加進 OBS**：不知道要新增哪一種音訊來源，也不知道要選哪個裝置或應用程式；甚至不知道是哪個應用程式在出聲。
5. **不清楚每個場景有哪些聲音**：使用者不知道目前在哪個場景、切換場景後哪些聲音會出現或消失。
6. **濾鏡難懂又難設定**：OBS 的濾鏡介面不直覺，而且很多人不知道噪音閘、壓縮器這些濾鏡是做什麼用的。
7. **第一次連線門檻高**：要先在 OBS 開啟 WebSocket 伺服器，再填 IP、連接埠和密碼，新手常常卡在這一步。

### 功能目標

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
| **自動調整人聲**（OBS）：錄 15–20 秒說話（直接取麥克風在濾鏡之前的聲音），分析音高、和平均語音頻譜比較、響度與底噪，自動設定高通、減 mud、齒音消除、壓縮器、presence、air 和限制器；用白話說明改了什麼，可以切換比較調整前後，舊濾鏡先備份、一鍵復原。需要外掛 0.5.0 | 6 |
| **濾鏡精靈**：用「你遇到什麼問題？」（背景有雜音、音量忽大忽小、怕爆音）推薦濾鏡，每個濾鏡都附白話說明，參數用視覺化方式調整 | 6 |
| **快速調整**：音量、靜音、聲道平衡、同步偏移 | 1 |
| **設定檔**：儲存和載入整套聲音設定 | — |

#### 來源狀態

OBS 的音量和濾鏡屬於音訊來源本身，不屬於場景；同一個來源放在多個場景時，設定是共用的。所以這個工具不做「每個場景各自的音量」，而是抓出所有場景用到的音訊來源，告訴使用者每個來源在**目前場景**的狀態：

| 狀態 | 意思 | 判斷方式 |
|---|---|---|
| 觀眾聽得到 | 在目前場景、沒有隱藏、沒有靜音、有送到直播音軌 | 以下條件都不成立 |
| 不在這個場景 | 只出現在其他場景，切過去才會有聲音 | 目前場景（含巢狀場景和群組）裡找不到它 |
| 已隱藏 | 在目前場景，但項目被隱藏（眼睛關掉），聲音不會送出 | 場景項目 `sceneItemEnabled` 為 false |
| 已靜音 | 在目前場景，但被靜音 | `GetInputMute` |
| 只有你聽得到 | 監聽模式是「僅監聽」：OBS 只送到耳機，不送到直播 | `GetInputAudioMonitorType` 為 `OBS_MONITORING_TYPE_MONITOR_ONLY` |
| 沒送到直播 | 在目前場景，但沒有勾選直播用的音軌，只有錄影聽得到 | `GetInputAudioTracks` 對照直播使用的音軌 |
| 全域 | OBS 設定裡加的桌面音訊／麥克風，每個場景都有 | `GetSpecialInputs` |

「觀眾聽得到」的來源再依音量表分成「正在出聲」和「目前沒聲音」，讓使用者一眼看出是不是有該出聲卻沒聲音的來源。

目前場景的來源排成**一個位置固定的清單**（全域來源在前，其他照 OBS 的順序），狀態只改變卡片的樣子（觀眾聽不到的會淡化並加虛線框），不會因為按了靜音或改了監聽就移到別的區塊，所以同一個位置再按一次就能切回來。上方摘要列出觀眾聽不到和目前沒聲音的來源，點一下會捲到那張卡片並閃一下。

#### 各功能的做法

- **連線引導**（`src/components/ConnectionGuide.tsx`）：連線失敗時依原因（沒有 OBS 設定檔、WebSocket 伺服器沒開、密碼不對、連不上連接埠、OBS 沒開）顯示對應的步驟；讀不到設定檔時可以手動輸入 IP、連接埠和密碼（存在 App 裡），也能改回自動讀取。
- **音量表建議範圍**：每個來源的音量表標出 -20～-9 dB（OBS 自己音量表的黃色區），峰值落在這裡最好。
- **快速調整**：每個來源的「更多設定」裡有左右平衡和聲音提早／延後（-950～20000 ms，OBS 的範圍）。
- **實況輸出音量表**（`src/components/StreamMeter.tsx`）：App 連上 OBS 且外掛已載入時，持續讀取直播音軌，顯示觀眾聽到的音量、峰值和最近 3 秒的響度（BS.1770 short-term LUFS），並另外列出「你的耳機會從 OBS 聽到哪些來源」。試音也從同一條連線取用聲音，外掛同時只有一個用戶端。
- **系統聲音偵測**（`src-tauri/src/system_audio.rs`，目前只支援 Windows）：用 WASAPI 列出每個播放裝置、錄音裝置和每個應用程式的音訊工作階段及即時峰值，再和 OBS 裡擷取裝置的 `device_id`、應用程式擷取的 `window`（比對執行檔名稱）對照，標出「沒有收進 OBS」「已在 OBS」「透過桌面音訊收進 OBS」。錄音裝置只有在有程式正在錄它時才會有音量，所以「還沒加進 OBS 的輸入裝置」另外列成一個可展開的清單，不顯示音量；新增精靈裡可以按「試聽」短暫開啟某個錄音裝置（最多 30 秒，期間 Windows 會顯示麥克風使用中），看它現在收到的音量。
- **新增音訊來源精靈**（`src/components/AddSourceWizard.tsx`）：先選「麥克風或其他輸入」「電腦播放的所有聲音」「某個應用程式的聲音」，再選裝置（或「跟著系統預設」）或正在出聲的程式，最後選名稱和要加到目前場景或所有場景。應用程式擷取設定成用執行檔比對視窗，程式重開也抓得到。
- **濾鏡精靈**（`src/components/FilterWizard.tsx`、`src/filters.ts`）：從問題選擇（背景有雜音、不說話時還有聲音、音量忽大忽小、大叫會爆音、整體太小聲，或一次設定好人聲）新增濾鏡，並自動放到建議的順序（噪音抑制 → 噪音閘 → 壓縮器 → 增益 → 限制器）。每個濾鏡附白話說明；噪音閘和限制器的門檻畫在即時音量條上，壓縮器畫出輸入／輸出曲線。
- **自動調整人聲**（`src/components/VoiceTuning.tsx`、`src/voiceTuning.ts`、`src-tauri/src/voice_analysis.rs`、外掛的 `voice-eq.cpp`、`voice-analyzer.cpp`）：libobs 先跑來源的濾鏡才交給 audio callback，所以要聽到麥克風原本的聲音，分析器濾鏡必須放在鏈的最前面；錄音時暫時加上、錄完移除，外掛把錄到的單聲道 float PCM 分段回傳。Rust 端做品質檢查（太小聲、爆音、底噪太高、說話太短時只回報問題，不套 EQ）、簡單 VAD、YIN 音高（高通頻率依音高下緣，最高 100 Hz）、1/3 倍頻程長期頻譜和 Byrne et al. 1994 universal LTASS 比較（200–500 Hz 多出 3 dB 以上才減、最多 −6 dB；2–5 kHz 不足才補、最多 +4 dB；5–9 kHz 明顯才開齒音消除；高頻有內容且底噪低才加 air），以及 K-weighting 響度與壓縮器門檻／比例／補償增益（目標 −16 LUFS）。濾鏡鏈：噪音抑制 → 人聲 EQ（修正：高通、減 mud、齒音消除）→ 壓縮器 →（需要時）增益 → 人聲 EQ（潤飾：presence、air）→ 限制器。被取代的舊濾鏡先停用以便比較，保留時才移除，並另存一份設定檔備份。
- **設定檔**（`src/profiles.ts`、`src-tauri/src/profiles.rs`）：把每個音訊來源的音量、靜音、監聽、平衡、提早延後、音軌和聲音濾鏡（含設定和順序）存成 JSON。套用前自動把目前的設定存成「套用前的備份＋時間」（保留最近 5 份）；設定檔裡沒有的濾鏡保留不動，在 OBS 改過名字的同種濾鏡會沿用並改回設定檔裡的名字，OBS 裡找不到的來源略過並列出；在別的場景集合存的設定檔，套用前會提醒。

#### 目前的限制

- 手動輸入其他電腦的 OBS 時，混音器、濾鏡精靈、設定檔可以用；試音、實況輸出音量表、外掛安裝、系統聲音偵測和應用程式擷取只對本機的 OBS 有效，連到其他電腦時會自動隱藏或停用。
- 濾鏡精靈裡的即時音量條量的是經過所有濾鏡之後的聲音（OBS 音量表的量法），所以噪音閘關上時音量條會掉到底。
- OBS 32 的噪音抑制只剩 RNNoise 和 Speex；NVIDIA 降噪在 OBS 裡是另外的濾鏡，精靈只顯示不調整。
- 系統聲音偵測和應用程式擷取目前只支援 Windows；macOS 的新增來源精靈只提供「跟著系統預設」的裝置。

### 直播監聽（OBS 外掛）

外掛在 OBS 的外掛管理員裡顯示為「SoundCheck」，檔名是 `soundcheck`，obs-websocket 的 vendor 名稱也是 `soundcheck`。專案原名 obs-audio-kit；安裝新版外掛時會一併移除舊的 `obs-audio-kit` 外掛，App 第一次啟動時也會把舊 App ID（`io.github.weisunglee.obsaudiokit`）存的設定檔搬過來。

obs-websocket 拿不到 OBS 混好的直播聲音，所以需要一個小型 OBS 外掛（`obs-plugin/`，C++，沿用 obs-live-translate 的建置方式）。外掛只負責「接出聲音」，播放和分析都在本工具裡做：

```
OBS 混音器 ──(直播用的音軌)──▶ 外掛 ──本機連線──▶ SoundCheck ──▶ 耳機
                                                    └─▶ 直播音量表、響度
```

- **接出聲音**：外掛用 libobs 的 `obs_add_raw_audio_callback(mix_idx, …)` 取得指定音軌的混音 PCM。
- **知道直播用哪條音軌**：外掛用 `obs_frontend_get_streaming_output()` + `obs_output_get_mixers()` 直接問 OBS，不用猜簡易／進階模式的設定。
- **控制**：外掛向 obs-websocket 註冊 vendor requests（`obs_websocket_register_vendor`），本工具用既有的 WebSocket 連線開關監聽、查詢音軌。
- **傳送聲音**：PCM 走本機 socket 送給本工具，不走 WebSocket（JSON 太重）。
- **播放**：本工具的 Rust 端播放到使用者選的耳機。

外掛只「讀」音軌，不新增音軌、來源或濾鏡，也不會把任何聲音放回 OBS 的混音。唯一會改動 OBS 設定的是試音：播放期間暫時取消勾選直播音軌，結束後還原。外掛在 OBS 裡沒有任何介面；OBS 啟動時自動載入，平常不做事，只有本工具要求時才接出聲音。

#### 試音

做法和一般軟體的麥克風測試一樣：先錄一段，再播放。錄音和播放不會同時進行，所以不管使用者用哪個裝置聽，都不會有回音。

1. **錄音**（預設 10 秒，最長 15 秒，可提前停止）：外掛讀取直播音軌，送給本工具暫存在記憶體。直播照常進行，觀眾聽得到。錄音時同時顯示即時音量表
2. **播放**：停止讀取音軌，在本工具裡播放剛才錄的聲音，並顯示這段的音量和響度摘要（例如「整體偏小，建議把麥克風調高 3 dB」）。播放期間，把所有來源暫時從直播音軌取消勾選，讓播放的聲音即使被「桌面音訊」擷取也不會送到直播；觀眾在這段時間聽不到聲音
3. **結束**：還原每個來源原本的音軌設定

**安全機制**：如果本工具在播放中當掉或斷線，音軌沒還原，直播就會一直沒聲音。所以取消勾選和還原由外掛負責，本工具在播放期間定期發送心跳；外掛超過幾秒沒收到心跳就自動還原。OBS 關閉前也要還原。

#### 一鍵安裝

外掛的請求協定、版本比較和「要不要安裝／更新」的判斷都在 `src/plugin.ts`（`createPlugin`、`assessPlugin`、`pluginApplies`），有單元測試；請求怎麼送到外掛由各軟體的 adapter 提供（`PluginLink`）。外掛的二進位檔打包在本工具裡，不另外下載（Windows 由 `src-tauri/tauri.windows.conf.json` 把建置好的 DLL 放進 App 資源）。只有 App 附的版本比 OBS 載入的（或已安裝檔案的）版本新時，才會提示安裝或更新；版本號以 `obs-plugin/buildspec.json` 為準。安裝流程：

1. 偵測 OBS 版本和外掛資料夾
2. OBS 正在執行時，請使用者關閉 OBS（Windows 上已載入的 DLL 無法覆寫，而且外掛要重開 OBS 才會載入）
3. 複製外掛到資料夾
4. 幫使用者重新開啟 OBS，連上後用 vendor request 確認外掛已載入

#### Streamlabs 版外掛

Streamlabs Desktop 沒有 obs-websocket，也沒有 OBS 主程式的介面，但它會載入 `%APPDATA%\slobs-plugins\obs-plugins\64bit\` 裡的 libobs 模組（啟動時自動載入；開著時也能從外部用 `ObsUserPluginsService.initializeModule` 立刻載入）。所以外掛另外編一個 Streamlabs 版 `soundcheck-streamlabs`（`cmake --preset windows-x64 -B build_x64_streamlabs -DSOUNDCHECK_STREAMLABS=ON`），請求處理和 OBS 版共用 `obs-plugin/src/requests.cpp`：

- **控制**：外掛開一個只接受本機連線的控制埠，把埠號和隨機 token 寫進 Streamlabs 給它的資料夾（`%APPDATA%\slobs-plugins\data\obs-plugins\soundcheck-streamlabs\control.json`）；App 由 Rust 的 `src-tauri/src/streamlabs_plugin.rs` 連過去，每個請求一行 JSON
- **直播音軌**：從正在送往直播服務的 output 讀 mixer；沒在直播時是音軌 1
- **安裝**：複製到上面的資料夾，不需要系統管理員權限。第一次安裝不用重開 Streamlabs，App 會叫它立刻載入（每次連線最多一次，且只在外掛沒回應時，避免載入兩次）；更新時 Streamlabs 必須先關閉，因為它開著時一直鎖住已載入的 DLL
- **Streamlabs 的 libobs 不一樣的地方**：為了同時輸出橫式和直式畫面，它對每個畫面各混一次音，把混音送給每個音訊回呼，而且會把回呼的 `param` 當成 `obs_encoder` 讀取。所以 tap 傳一塊全零的 `param`、不請 libobs 轉換格式（libobs 的轉換器會同時吃到兩個畫面的聲音）、依時間戳記只留第一份（主畫面），再自己轉成 48 kHz。這在 OBS 上效果相同
- **暫停直播聲音**：外掛直接改 libobs 的音軌設定，Streamlabs 自己記錄的音軌設定不變，所以暫停期間它存檔或當掉，存下的仍是原本的設定
- **來源音量表**：Streamlabs 不給外部程式音量資料，外掛用 libobs 自己的音量表（`obs_volmeter`，Streamlabs 和 OBS 的混音器也用它）量每個音訊來源，App 每 100 ms 用 `GetSourceLevels` 讀一次，格式和 obs-websocket 的 `InputVolumeMeters` 相同。所以控制連線是一條持續的連線（`streamlabs_plugin.rs`），不是每個請求開一條；沒裝外掛時不顯示音量條
- 驗證：`node tools/verify-streamlabs-plugin.mjs`（載入、控制埠與 token、來源音量表、tap 取樣率、暫停／心跳／恢復／自動恢復、Streamlabs 的音軌設定不變）在實際的 Streamlabs（libobs 31.1.2sl）上對外掛 0.4.0 全部通過，共 17 項，包含來源音量表（3 個音訊來源都有讀數、連續讀取正常）

| 平台 | 外掛資料夾 | 需要系統管理員權限 |
|---|---|---|
| Windows | `C:\ProgramData\obs-studio\plugins\soundcheck\bin\64bit\` | 不需要（見驗證紀錄） |
| macOS | `~/Library/Application Support/obs-studio/plugins/soundcheck.plugin` | 不需要 |
| Linux | `~/.config/obs-studio/plugins/soundcheck/bin/64bit/` | 不需要（Flatpak 版 OBS 不支援） |

安裝的每一步（安裝視窗顯示的狀態、使用者按的按鈕、複製結果、系統管理員權限複製的輸出）都會寫進安裝紀錄 `install.log`：

| 平台 | 位置 |
|---|---|
| Windows | `%LOCALAPPDATA%\io.github.weisunglee.soundcheck\logs\install.log` |
| macOS | `~/Library/Logs/io.github.weisunglee.soundcheck/install.log` |
| Linux | `~/.local/share/io.github.weisunglee.soundcheck/logs/install.log` |

#### 驗證紀錄

在 Windows 11（OBS 32.2.2）上驗證過，外掛以 OBS 31.1.1 原始碼建置：

- **外掛載入**（改名前的紀錄，當時叫 obs-audio-kit）：放進 `C:\ProgramData\obs-studio\plugins\obs-audio-kit\bin\64bit\` 後重開 OBS 即可載入，log 有 `[obs-audio-kit] module loaded`
- **OBS 32 外掛管理員**：新外掛自動加入 `plugin_manager\modules.json`，預設 `enabled=true`，使用者不需要手動啟用
- **接出直播音軌**：`StartTap` 接出音軌 1，15 秒收到 15.00 秒音訊（實際耗時 15.01–15.02 秒），沒有掉資料；錄到的峰值和 OBS 自己的音量表一致（-14.8 dBFS 對 -14.8 dBFS）
- **直播用哪條音軌**：沒在直播時，從進階模式的設定（`AdvOut` / `TrackIndex`）正確讀到音軌 1
- **自動連線**：讀取 `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json` 的連接埠和密碼就能連上 obs-websocket 5.7.4，不需要使用者輸入
- **試音播放時暫停直播聲音**（`pause-test.mjs`，8 項全部通過）：暫停時 21 個音訊來源全部離開直播音軌，其他音軌不受影響；重複暫停會被拒絕；有心跳時維持暫停；心跳停止後外掛在逾時（2 秒）後自動還原；明確還原也會立即恢復。測試前後每個來源的音軌設定完全相同
- **試音功能（App）**：使用者在 Windows 上實際操作錄音、看結果、播放，聲音正常
- **混音器使用真實 OBS 資料**：在 7 個場景、1 個群組、21 個音訊來源的實際設定上讀取正確（`tools/inspect-obs.ts`），各場景的來源狀態判斷正確（含巢狀場景與群組）；使用者實際操作確認 App 和 OBS 的雙向同步、音量表都正常
- **一鍵更新外掛**（依 `install.log`）：App 偵測到 OBS 載入 0.1.0、附的是 0.2.0，顯示更新；OBS 關閉後一般權限複製被拒（資料夾擁有者是 Administrators），改用系統管理員權限複製成功，檔案版本確認為 0.2.0；「開啟 OBS」後連線並確認 OBS 載入 0.2.0
- **App 在背景時偵測 OBS 開啟**：Windows WebView2 會壓慢甚至暫停背景視窗的計時器（Tauri 的 `backgroundThrottling` 在 Windows 不支援），所以改由 Rust 端每秒檢查 OBS 程序和 WebSocket 連接埠，一可連線就通知介面連線；視窗回到前景時也會立即重試。使用者確認先開 App、最小化、再自己開 OBS 的情況能正常偵測
- **濾鏡精靈與設定檔**（`tools/verify-features.ts`，25 項全部通過，只在暫時建立再刪除的場景和來源上操作）：精靈寫入的設定欄位和 OBS 一致；不論加入順序，濾鏡都排成建議順序；拉桿、移動、新增、移除都會反映到 OBS；設定檔存下後改掉音量、靜音、平衡、提早延後、監聽、音軌和濾鏡，套用後全部還原；應用程式擷取的 `priority` 2 確認是「依執行檔比對」
- **其他新功能**：使用者在 Windows 上實際操作連線引導、實況輸出音量表、系統聲音偵測、新增來源精靈、濾鏡精靈、左右平衡與提早延後、設定檔和試音，全部正常
- **固定位置的混音器與輸入裝置**：使用者確認連按靜音時卡片不會移位、摘要標籤能捲到對應卡片、「還沒加進 OBS 的輸入裝置」清單正確、新增精靈的試聽能顯示麥克風音量；`print_listen_levels` 測試確認開啟錄音裝置後 Windows 會回報音量（例如 Audient iD4 Mic 0.022）
- **Windows 資料夾權限**：`C:\ProgramData\obs-studio\plugins` 的 ACL 讓一般使用者可以新建資料夾，且對自己建的資料夾有完整權限，推論全新安裝不需要 UAC。但如果資料夾是用提權方式建的（擁有者變成 Administrators），之後一般權限就無法更新或刪除，所以**安裝程式必須一律用一般權限安裝**，不能有時提權有時不提權

#### 待驗證

- Streamlabs Desktop 連接層：`npx tsx tools/verify-streamlabs.ts`（在暫時來源上驗證監聽、音軌、提早延後、音量、靜音、事件、濾鏡精靈和設定檔，28 項）在實際的 Streamlabs 上通過；連線、讀取場景與來源、切換場景、顯示來源、新增來源還要在 App 裡實際操作確認
- OBS 改了 WebSocket 連接埠或密碼後，App 是否會自動用新設定重連（每次連線都會重新讀設定檔，但還沒實測）
- 直播中時，從直播輸出的 mixer mask 讀取直播音軌（`streamTracksOrigin: "output"`）
- 簡易輸出模式下的直播音軌判斷
- 一般權限（非提權）的程式實際寫入 `C:\ProgramData\obs-studio\plugins` 是否成功（目前只從 ACL 推論）
- macOS 上未簽章的外掛能否載入、複製後是否要移除 quarantine 屬性
- 最低支援的 OBS 版本（較新版本建置的外掛，舊版 OBS 不會載入，所以要用最低支援版本建置）
- 播放期間取消勾選、再還原音軌時，直播中的觀眾端是否會有爆音或短暫斷音（目前只在沒直播時測過）
- 試音結果的判斷門檻（偏小 < -24 LUFS、偏大 > -10 LUFS，以 YouTube 的 -14 LUFS 為參考）目前是暫定值，要用更多實際錄音調整
- **已知風險**：暫停期間如果 OBS 剛好自動儲存場景集合，又在幾秒內當掉，下次開 OBS 時部分來源可能仍未勾選直播音軌。正常關閉 OBS 或 App 都會先還原

### 直播軟體連接層

`src/adapter.ts` 是 SoundCheck 和直播軟體之間的 seam：每個直播軟體一個 adapter（`src/obsAdapter.ts`、`src/streamlabsAdapter.ts`），提供讀取狀態、回報變更和各種設定操作；做不到的操作直接不提供，`capabilitiesOf()` 依此推導介面要隱藏哪些功能。`src/audio.ts` 的 `useAudio` 是所有軟體共用的狀態層（載入、套用變更、結構變更後重新讀取、操作時先更新畫面）；濾鏡精靈（`src/filters.ts`）和設定檔（`src/profiles.ts`）也只透過 adapter 操作。obs-websocket 連線本身在 `src/obsClient.ts`，連線和重試流程在 `src/connection.ts`。Streamlabs 的 JSON-RPC 用戶端在 `src/streamlabs.ts`，傳輸由 Rust 的 `src-tauri/src/slobs.rs` 負責（tokio 的 named pipe／Unix socket）；`src-tauri/src/presence.rs` 每秒偵測兩個軟體是否在執行、是否可以連線。

Streamlabs 的音量用 libobs 的 IEC 推桿曲線（deflection 0～1 對應 -60～0 dB），所以 SoundCheck 設定音量時先把 dB 換成 deflection。推桿、監聽、音軌、提早延後的變更來自 `AudioService.audioSourceUpdated`，靜音和改名來自 `SourcesService.sourceUpdated`，濾鏡和場景結構也都有事件。幾個要注意的地方：
- Streamlabs 給所有外部程式共用每秒 2 點的呼叫額度，`getScenes` 每次耗 1 點；超過時用戶端會等 1 秒重試，靜音之類的小變更也直接套用，不整份重新讀取
- 它自己記錄的濾鏡設定只存最後一次送去的內容，所以改濾鏡設定時一律讀出完整設定（從屬性表單讀，含預設值）合併後整份送出
- 濾鏡排序只能「往上下移幾格」，不能改名；設定檔遇到被改名的同種濾鏡會改成新增一個

### 技術架構

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
npm run check:i18n    # 檢查每種語言都翻譯了所有介面文字
```

### 自動建置與發布

`.github/workflows/build.yml` 在每個 PR 和每次 push 到 `main` 時執行：型別檢查、單元測試、翻譯檢查，接著在 Windows 和 macOS（universal）上跑 Rust 測試、編譯外掛並打包 App，安裝檔放在每次執行的附件裡。

要發布新版本，改版號後 push 到 `main`：

```sh
npm run bump -- 0.3.0     # 或 patch／minor／major，會一起改所有存版號的檔案
git commit -am "Release 0.3.0" && git push
```

push 讓 `src-tauri/tauri.conf.json` 的版號變成一個還沒有 tag 的版號時，兩個平台會打包進草稿 Release `v0.3.0`，檢查都通過、兩個安裝檔都上傳後才正式發布。外掛有自己的版號，在 `obs-plugin/buildspec.json`。安裝檔目前都沒有程式碼簽章：Windows 的 SmartScreen 會警告「不明發行者」，macOS 第一次開啟要按右鍵 →「打開」。

### 語言

介面文字在程式碼裡寫繁體中文，用 `t("…")` 包起來；其他語言的翻譯在 `src/locales/`，以繁體中文原文為鍵（gettext 的做法）。新增或修改文字後執行 `npm run check:i18n`，它會列出缺少的翻譯、沒在用的翻譯，以及 `{變數}` 對不上的地方。存在資料裡、之後才顯示的文字用 `msg("…")` 標記，顯示時再 `t(value)`。

一般文字用「直播軟體」稱呼，只有需要點特定選單的步驟才用 `{app}` 帶出軟體名稱（`src/i18n.tsx` 的 `setSoftwareName`）。後端（Rust）產生的訊息在 `src-tauri/src/i18n.rs`，介面切換語言時會一起切換。

App 啟動後會自動讀取本機 OBS 的 WebSocket 設定並連線。`npx tsx tools/inspect-obs.ts` 可以在有 OBS 的電腦上印出 App 會看到的資料和各場景的來源狀態。

## 授權

- App 和 `obs-plugin/` 以外的所有內容採用 [MIT 授權](LICENSE)。
- `obs-plugin/` 裡的外掛採用 [GNU GPL v2.0 或更新版本](obs-plugin/LICENSE)，因為它連結了 OBS 的 libobs，也用了 obs-websocket 的 API 標頭檔，兩者都是 GPL-2.0-or-later。App 是透過本機連線跟外掛溝通，沒有連結外掛，所以 App 維持 MIT；安裝檔裡的外掛旁邊附有外掛的授權條文。
- 圖示來自 [Lucide](https://lucide.dev)（ISC 授權，見 `third_party/lucide-LICENSE.txt`）。
