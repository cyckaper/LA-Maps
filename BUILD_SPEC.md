# 基地分析工作站 — Claude Code 建置規格書
### Site Analysis Studio · 真實台灣圖資 · 免費 MVP

> 用途:給 Claude Code 照著建置的完整規格。把本檔(或最末「起手提示語」)貼進 Code 分頁的對話,在你的 GitHub repo 上執行。

---

## 0. 目標與範圍

建一個網頁版基地分析工具:在地圖上**點一個點**或**畫一塊基地範圍**,系統就自動產出七項分析,並可疊上國家級圖資做判讀、下載報告。

**本階段(免費 MVP)範圍:**
- 真實圖資:內政部國土測繪中心(NLSC)臺灣通用電子地圖、正射影像、國土利用調查成果圖(全部免費、免申請)。
- 真實人口:內政部 SEGIS / 戶政司 鄉鎮市區層級人口統計與指標(空間對應後查出真實數值)。
- 在地評價:使用者貼上 Google 評論／PTT／Dcard 文字,做文字探勘(不爬蟲、不踩平台條款)。
- AI 解讀:由 Claude 將真實數據綜整為可讀分析。
- 零計費、可免費部署。

**本階段明確不做(列為後續階段):**
- Google Places API(計費)、村里/最小統計區付費電信信令、Landsat 地表溫度即時運算。
- 熱環境僅以國土利用之綠覆/不透水鋪面當代理指標 + AI 研判。

---

## 1. 技術架構

採「靜態前端 + 一支雲端函式」最小架構,便於單人長期維護:

- **前端**:純 HTML/CSS/JavaScript + [Leaflet] 地圖 + [Turf.js](點對多邊形空間運算) + [Leaflet.draw](繪製範圍)。不使用框架,降低維護負擔。
- **資料**:台灣鄉鎮市區界 GeoJSON + 人口統計 JSON,打包在 repo 的 `/public/data/`,前端直接讀取、在瀏覽器內做空間對應。
- **AI 解讀層**:一支雲端函式(Cloudflare Pages Functions 或 Vercel Function)持有 `ANTHROPIC_API_KEY`,代理呼叫 Anthropic API;前端呼叫 `/api/analyze`,金鑰不外露。
- **部署**:建議 **Cloudflare Pages**(免費方案同時提供靜態託管、Functions、環境變數密鑰)。若選 GitHub Pages(純靜態、無後端),則 AI 解讀層需省略或僅在 Claude 內執行。

---

## 2. 真實資料來源與端點(已驗證)

### 2.1 NLSC 圖磚(WMTS,免費免申請)
圖磚網址格式(`GoogleMapsCompatible` 等同標準 XYZ,Leaflet 可直接用):
```
https://wmts.nlsc.gov.tw/wmts/{LAYER}/default/GoogleMapsCompatible/{z}/{y}/{x}
```
可用圖層代碼:
- `EMAP` — 臺灣通用電子地圖(預設底圖)
- `EMAP5` — 通用電子地圖(套疊等高線+門牌)
- `PHOTO2` — 正射影像圖(通用版)
- `LUIMAP` — 國土利用調查成果圖(土地使用疊圖,半透明)
- `LUIMAP01`~`LUIMAP09` — 九大類分層:1 農業、2 森林、3 交通、4 水利、5 建築、6 公共設施、7 遊憩、8 礦鹽、9 其他

`GetCapabilities`:`https://wmts.nlsc.gov.tw/wmts?SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0`

### 2.2 NLSC WMS(查詢點位土地使用類別,可選強化)
端點:`https://wms.nlsc.gov.tw/wms`。可對 `LUIMAP` 發 `GetFeatureInfo` 請求,取得點擊座標的實際土地使用類別。實作時先測試是否回傳屬性;若不支援,退回「LUIMAP 疊圖 + AI 研判」。WMS 另提供向量界線圖層 `CITY`(縣市界)、`TOWN`
