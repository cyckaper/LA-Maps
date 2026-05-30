# 基地分析工作站 · Site Analysis Studio

以**真實台灣政府開放圖資**為基礎的基地（site）分析網頁工具:在地圖上放標記或畫出基地範圍,即可一次取得**人口結構、開放空間/綠地可及性、熱環境與健康研判、法規對照**,並由 **Claude AI** 產出可讀的綜合報告、匯出 PDF。

> ⚠️ 本工具分析僅供規劃參考,不構成正式法定文件或專業意見。詳見「方法與限制」。

---

## 線上版本

| 網址 | 後端 | AI 解讀 | 用途 |
|---|---|---|---|
| **https://healsdesign.org**(Netlify) | ✅ Netlify Functions | ✅ 可用 | **主要版本** |
| https://la-maps.pages.dev | ✅ Cloudflare Pages | ✅ 可用 | 備援 |
| https://cyckaper.github.io/LA-Maps/ | ❌ 純靜態 | ❌ 不可 | 前端預覽 |

功能相同,差別僅在 AI 解讀需要後端(金鑰)。

---

## 功能總覽

### 底圖與疊圖
- **底圖**(NLSC WMTS):臺灣通用電子地圖 (EMAP)、正射影像+路名套疊 (PHOTO_MIX)、正射影像 (PHOTO2)
- **疊圖圖層(官方圖資,可多選 + 共用透明度)**
  - 國土利用調查(綠地/土地利用)— NLSC,綠地實況視覺參考
  - 各級學校範圍(學區)— NLSC
  - 段籍圖(地籍)— NLSC
  - 土壤液化潛勢 — 經濟部地質調查及礦業管理中心 WMS
  - 活動斷層分布線(2021) — 地質調查所 WMS
  - 活動斷層地質敏感區(帶狀) — 地質調查所 WMS

### 工具
- 地名搜尋(OpenStreetMap Nominatim)
- 點選放標記 / 繪製基地範圍(多邊形)/ 清除
- 基地面積量測(公頃,turf.js)

### 人口與指標
點一個點查**村里**、畫一塊面查**鄉鎮市區**,顯示真實戶政指標:
人口數、戶數、人口密度、性別比、老化指數、扶養比、扶幼比、扶老比、高齡比例(65+)、幼年比例(0-14)等。

### 開放空間 · 綠地(OpenStreetMap 即時查詢)
以焦點周邊 500m 服務圈分析,並分兩類:
- **公園(≥0.1ha)**:最近公園距離/面積、300m & 500m 內公園數、公園面積
- **零星綠地(草地·小塊)**:處數、面積
- **整體**:綠覆率(全綠地)、3-30-300 可及性
- **法規對照**:都市計畫法 §45(公園綠地廣場兒童遊樂場 ≥ 計畫面積 10%)、通盤檢討辦法(兒童遊樂場 ≥0.1ha、閭鄰公園 ≥0.5ha、社區公園 ≥4ha)、3-30-300 準則

### 熱環境 · 健康研判
綠覆率(對 3-30-300 的 30% 樹冠目標)× 脆弱族群(高齡 + 幼年比例)→ 綜合**高溫脆弱度**(低/中/高)。屬研判,非實測。

### AI 解讀
將上述真實數值送至後端 `/api/analyze`,由 Claude 產生五段式繁中報告(基地概述 / 開放空間綠地 / 熱環境健康 / 規劃建議 / 資料與限制),嚴格限定只用提供的數值並引用法規。

### 報告匯出
「匯出 / 列印報告」另開乾淨獨立頁面,可列印或**儲存成 PDF**(含人口/綠地/熱環境/AI 報告/資料來源)。

---

## 架構

```
┌─────────────────────────────────────────────┐
│ 瀏覽器 (public/)                              │
│  Leaflet 地圖 + turf.js 量測                  │
│  ├─ NLSC WMTS 圖磚 / 地質調查所 WMS           │
│  ├─ public/data/*.json(界線+人口,建置時產) │
│  ├─ OSM Overpass(綠地,即時)/ Nominatim     │
│  └─ POST /api/analyze ──────────┐             │
└─────────────────────────────────┼────────────┘
                                   ▼
            Cloudflare Pages Function (functions/api/analyze.js)
            持環境變數 ANTHROPIC_API_KEY → 呼叫 Anthropic API
```

- **前端**:純靜態(`public/`),無框架,vanilla JS。
- **資料**:`public/data/{towns,villages,meta}.json` 由 `scripts/build-data.mjs` 於**建置時**抓取界線 + 戶政人口產生(不進版控)。
- **後端**:`functions/api/analyze.js`(Cloudflare Pages Function),持金鑰呼叫 Claude;前端金鑰不外露。

---

## 專案結構

```
.
├── public/                  # 靜態網站(部署輸出目錄)
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js            # 主程式(地圖、分析、AI、匯出)
│   └── data/                # 建置時產生(gitignored)
│       ├── towns.json       # 鄉鎮市區界線 + 人口指標
│       ├── villages.json    # 村里界線 + 人口指標
│       └── meta.json        # 資料來源、統計期、對應率
├── functions/api/analyze.js # Cloudflare Function:/api/analyze
├── scripts/build-data.mjs   # 界線 + 人口資料建置腳本
├── .github/workflows/pages.yml # GitHub Pages 自動部署
└── package.json
```

---

## 在地開發 / 建置

需 Node 20+。

```bash
npm install
npm run build:data        # 產生 public/data/*.json(需網路)
# 以任意靜態伺服器開啟 public/,例如:
npx serve public          # 或 python3 -m http.server -d public
```

> 在地開啟時 AI 解讀無法使用(無後端);其餘功能正常。

---

## 部署

### Netlify(主要,含 AI,掛自有網域 healsdesign.org)
1. Add new site → Import an existing project → 選本 repo(`netlify.toml` 已含 build 設定)
2. Site configuration → Environment variables:`ANTHROPIC_API_KEY` = Anthropic API 金鑰 → 重新部署
3. 後端 `netlify/functions/analyze.mjs` 以 Functions 2.0 的 `config.path` 直接掛在 `/api/analyze`
4. Domain management → Add a domain → `healsdesign.org`(DNS 已在 Netlify,SSL 自動)

### Cloudflare Pages(備援,含 AI)
1. Workers & Pages → Create → Pages → Connect to Git → 選本 repo
2. Build 設定:
   - **Build command**:`npm install && node scripts/build-data.mjs`
   - **Build output directory**:`public`
   - Production branch:`main`
3. Settings → Variables and Secrets:
   - `ANTHROPIC_API_KEY`(Secret)= Anthropic API 金鑰
4. `functions/` 會被自動辨識為 `/api/*`。

### GitHub Pages(前端預覽,無 AI)
`.github/workflows/pages.yml` 於推送 `main` 時自動:`npm install` → `node scripts/build-data.mjs` → 發佈 `public/`。

---

## 資料來源與授權

| 項目 | 來源 |
|---|---|
| 底圖圖磚 / 疊圖(電子地圖、影像、國土利用、學區、地籍) | 內政部國土測繪中心 (NLSC) WMTS |
| 行政界線(村里、鄉鎮市區) | NLSC / [taiwan-atlas](https://github.com/dkaoster/taiwan-atlas)(TopoJSON, MIT) |
| 人口統計 | 內政部戶政司 rs-opendata(ODRP 系列) |
| 綠地圖徵 | © OpenStreetMap 貢獻者(ODbL),經 Overpass API |
| 地名搜尋 | OpenStreetMap Nominatim |
| 土壤液化 / 活動斷層 | 經濟部地質調查及礦業管理中心 WMS |
| AI 解讀 | Anthropic Claude |

---

## 技術棧
Leaflet 1.9 · Leaflet.draw · turf.js 6.5 · marked 12 · Cloudflare Pages Functions · Anthropic API · Node(建置:topojson-client)

---

## 方法與限制
- **綠地與綠覆率**:來自 OpenStreetMap 即時查詢,屬**下限估計**,可能不完整;官方綠地實況請對照「國土利用調查」疊圖。
- **熱環境 / 健康**:依代理指標(綠覆率、脆弱族群)與實證關聯之**研判**,非實測氣溫或健康數據。
- **法規對照**:§45 的 10% 是針對「都市計畫區」整體而非單一基地,工具以準則對照呈現,非合法性認定。
- **AI 報告**:僅依提供之數值生成,缺漏會標示「資料不足」。
- **適用範圍**:本工具僅供規劃參考,不構成正式法定文件或專業意見。

## 待辦
- **淹水潛勢**圖層:資料於 NCDR(需申請帳號),取得開放端點後可比照地質 WMS 接入。
