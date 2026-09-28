# 導航語音(TTS)

導航播報都經過 `NavTTS.speak(text)`(`tts/nav-tts.js`)，實際由哪個引擎念由這裡決定：

| 引擎 | 說明 |
|---|---|
| `piper`(預設) | 開源 Piper TTS，在手機/電腦**本機**用 WASM 合成(`piper-worker.js`，背景執行緒)，不需要 API Key、不按次計費。模型下載一次後存在瀏覽器 Cache Storage，之後離線可用 |
| `system` | 瀏覽器內建語音(原本的做法)。Piper 還在下載、載入失敗，或某句來不及合成時自動改用它 |

## 檔案

- `nav-tts.js`：引擎介面、Piper/系統語音兩個引擎、預先合成快取、播放(共用頁面的 AudioContext 與導航音量)
- `piper-worker.js`：Web Worker，載入 onnxruntime-web + 模型並合成
- `piper-zh.js`：中文前處理(繁轉簡 → 數字轉中文 → 拼音 → Piper 音素 id)，對應 Piper 1.4+ 的 `phonemize_chinese.py`；合成後修剪頭尾靜音、縮短過長停頓
- `piper/`：(選用)自架模型放這裡

## 語音模型

預設 **`zh_CN-xiao_ya-medium`**(女聲，約 63 MB)。注意：此模型的訓練資料**僅限非商業用途**。
不需要手動下載：第一次開網頁時會自動從 Hugging Face 下載並快取(換語音時舊模型會自動從快取刪掉)。

想自架(不依賴 Hugging Face)就把這兩個檔案放進 `tts/piper/`，網頁會優先用這裡的：

- https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/xiao_ya/medium/zh_CN-xiao_ya-medium.onnx
- https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/xiao_ya/medium/zh_CN-xiao_ya-medium.onnx.json

若要商用，可改用 `zh_CN-chaowen-medium`(男聲，CC0)：在主控台執行
`localStorage.setItem('navPiperVoice','zh_CN-chaowen-medium')` 後重新整理即可切換。
只支援 `phoneme_type = pinyin` 的模型；`zh_CN-huayan-*`(espeak 音素、授權不明)不支援。

## 速度

WASM 單執行緒合成速度約等於語音長度(桌機 0.5~1 倍、手機可能更慢)，所以：

- 固定語句(900~100公尺、通過、您已超速、已到達目的地)開頁後先在背景合成
- 測速照相首次提醒在 1.6 公里時先合成
- 接下來兩個路口的轉彎播報在換路段時先合成
- 沒預先合成到、估計來不及的句子直接用系統語音念，不延遲播報

## 主控台指令

```js
NavTTS.status()                          // 引擎狀態、下載進度、已快取句數
NavTTS.speak('1公里後有測速照相，固定式，限速60公里。')
NavTTS.setEngine('system')               // 改回系統語音；NavTTS.setEngine('piper') 換回來
simulateSpeedCameraApproach(60, 72)      // 模擬以 72 km/h 開向限速 60 的測速照相(含超速提醒)
simulateSpeedCameraApproach(60, 50)      // 不超速的版本
```
