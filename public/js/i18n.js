/* 簡易雙語 i18n:中文(預設)/ English
 * 用法:
 *   HTML 元素加 data-i18n="key" → applyI18n() 會填入對應語言文字
 *   JS 動態文字用 window.t("key") 取得字串
 *   語言記錄於 localStorage("lang")
 */
(function () {
  "use strict";

  var DICT = {
    "app.title": { zh: "基地分析工作站", en: "Site Analysis Studio" },
    "app.subtitle": { zh: "Site Analysis Studio · 真實台灣圖資", en: "Real Taiwan Open Data" },

    "search.h": { zh: "地名搜尋", en: "Place Search" },
    "search.placeholder": { zh: "輸入地名,例如:台灣大學", en: "Enter a place, e.g. NTU" },
    "search.btn": { zh: "搜尋", en: "Search" },

    "basemap.h": { zh: "底圖", en: "Base Map" },
    "basemap.emap": { zh: "臺灣通用電子地圖 (EMAP)", en: "Taiwan E-Map (EMAP)" },
    "basemap.photomix": { zh: "正射影像+路名套疊 (PHOTO_MIX)", en: "Orthophoto + Labels (PHOTO_MIX)" },
    "basemap.photo2": { zh: "正射影像 (PHOTO2)", en: "Orthophoto (PHOTO2)" },

    "overlay.h": { zh: "疊圖圖層(官方圖資)", en: "Overlays (Official Data)" },
    "overlay.opacity": { zh: "透明度", en: "Opacity" },
    "overlay.hint": {
      zh: "綠地以「國土利用調查」官方圖層為視覺實況參考(較 OSM 完整);分析數值仍以 OSM 計算。",
      en: "Use the official Land-Use Survey overlay as a visual reference (more complete than OSM); analysis figures still come from OSM."
    },
    "overlay.LUIMAP": { zh: "國土利用調查(綠地/土地利用)", en: "Land-Use Survey (green/land use)" },
    "overlay.SCHOOL": { zh: "各級學校範圍(學區)", en: "School Boundaries" },
    "overlay.LANDSECT": { zh: "段籍圖(地籍)", en: "Cadastral Map" },
    "overlay.LIQUEFACTION": { zh: "土壤液化潛勢", en: "Soil Liquefaction Potential" },
    "overlay.FAULT": { zh: "活動斷層分布線(2021)", en: "Active Fault Lines (2021)" },
    "overlay.FAULT_ZONE": { zh: "活動斷層地質敏感區(帶狀)", en: "Active Fault Sensitive Zone" },
    "overlay.warn": { zh: "⚠ 無法載入(端點待確認)", en: "⚠ Failed to load (endpoint TBD)" },

    "tools.h": { zh: "工具", en: "Tools" },
    "tools.marker": { zh: "點選放標記", en: "Place Marker" },
    "tools.polygon": { zh: "繪製基地範圍", en: "Draw Site" },
    "tools.clear": { zh: "清除全部", en: "Clear All" },
    "tools.hint": { zh: "提示:選「點選放標記」後,在地圖上點擊即可放置標記。", en: "Tip: choose Place Marker, then click the map to drop a marker." },

    "area.h": { zh: "基地面積", en: "Site Area" },
    "area.unit": { zh: "公頃", en: "ha" },

    "pop.h": { zh: "人口與指標", en: "Population & Indicators" },
    "pop.loading": { zh: "載入圖資中…(點一個點查村里、畫一塊面查鄉鎮)", en: "Loading data… (click a point for village, draw an area for township)" },

    "green.h": { zh: "開放空間 · 綠地", en: "Open Space · Green" },
    "green.btn": { zh: "分析周邊綠地", en: "Analyze Green Space" },
    "green.hint": { zh: "先放標記或畫基地,再按「分析周邊綠地」。", en: "Place a marker or draw a site, then click Analyze Green Space." },

    "heat.h": { zh: "熱環境 · 健康研判", en: "Heat & Health Assessment" },
    "heat.hint": { zh: "按上方「分析周邊綠地」後,這裡顯示熱環境與脆弱族群研判。", en: "After analyzing green space, heat and vulnerability assessment appears here." },

    "biodiv.h": { zh: "生態 · 生物多樣性", en: "Ecology · Biodiversity" },
    "biodiv.btn": { zh: "查詢周邊物種紀錄", en: "Query Species Records" },
    "biodiv.hint": { zh: "先放標記或畫基地,再按「查詢周邊物種紀錄」。", en: "Place a marker or draw a site, then click Query Species Records." },

    "ai.h": { zh: "AI 解讀", en: "AI Analysis" },
    "ai.btn": { zh: "產生 AI 基地分析報告", en: "Generate AI Site Report" },
    "ai.export": { zh: "匯出 / 列印報告(可存 PDF)", en: "Export / Print Report (PDF)" },

    "credits.h": { zh: "資料來源與版權", en: "Data Sources & Credits" },
    "credits.basemap": { zh: "底圖圖磚:內政部國土測繪中心 (NLSC)", en: "Base tiles: NLSC, Taiwan" },
    "credits.boundary": { zh: "行政界線:NLSC / taiwan-atlas(村里、鄉鎮市區)", en: "Boundaries: NLSC / taiwan-atlas (village, township)" },
    "credits.pop": { zh: "人口統計:內政部戶政司 ODRP014(11412 期)", en: "Population: MOI Household Registration ODRP014 (2025-12)" },
    "credits.geo": { zh: "地質圖層(土壤液化/活動斷層):經濟部地質調查及礦業管理中心", en: "Geology (liquefaction/faults): Geological Survey & Mining Mgmt Agency, MOEA" },
    "credits.osm": { zh: "綠地圖徵:© OpenStreetMap 貢獻者(ODbL),經 Overpass API 即時查詢", en: "Green features: © OpenStreetMap contributors (ODbL), via Overpass API" },
    "credits.nominatim": { zh: "地名搜尋:OpenStreetMap Nominatim", en: "Place search: OpenStreetMap Nominatim" },
    "credits.inat": { zh: "生物多樣性:iNaturalist(CC 觀測資料)", en: "Biodiversity: iNaturalist (CC observations)" },
    "credits.ai": { zh: "AI 解讀:Anthropic Claude", en: "AI analysis: Anthropic Claude" },
    "credits.disclaimer": {
      zh: "免責聲明:綠地與綠覆率為 OpenStreetMap 即時查詢,屬下限估計,可能不完整;熱環境/健康為依代理指標之研判,非實測氣溫或健康數據。本工具分析僅供規劃參考,不構成正式法定文件或專業意見。",
      en: "Disclaimer: green space and canopy figures are live OSM queries (lower-bound estimates, possibly incomplete); heat/health results are proxy-based assessments, not measured temperature or health data. For planning reference only; not an official or professional document."
    },
    "foot.author": {
      zh: "張俊彥 國立臺灣大學園藝暨景觀學系特聘教授",
      en: "Chun-Yen Chang, Distinguished Professor, Department of Horticulture and Landscape Architecture, National Taiwan University"
    },
    "foot": { zh: "© 2026 基地分析工作站 · Site Analysis Studio · 僅供參考", en: "© 2026 Site Analysis Studio · For reference only" },

    "lang.toggle": { zh: "EN", en: "中" },

    // 疊圖圖層名稱(動態建立)
    "ov.LUIMAP": { zh: "國土利用調查(綠地/土地利用)", en: "Land-Use Survey (green/land use)" },
    "ov.SCHOOL": { zh: "各級學校範圍(學區)", en: "School Boundaries" },
    "ov.LANDSECT": { zh: "段籍圖(地籍)", en: "Cadastral Map" },
    "ov.LIQUEFACTION": { zh: "土壤液化潛勢", en: "Soil Liquefaction Potential" },
    "ov.FAULT": { zh: "活動斷層分布線(2021)", en: "Active Fault Lines (2021)" },
    "ov.FAULT_ZONE": { zh: "活動斷層地質敏感區(帶狀)", en: "Active Fault Sensitive Zone" },
    "ov.warn": { zh: "⚠ 無法載入(端點待確認)", en: "⚠ Failed to load (endpoint TBD)" },

    // 人口指標標籤
    "ind.pop": { zh: "人口數", en: "Population" },
    "ind.households": { zh: "戶數", en: "Households" },
    "ind.density": { zh: "人口密度", en: "Pop. density" },
    "ind.household_size": { zh: "戶量", en: "Persons/household" },
    "ind.sex_ratio": { zh: "性比例", en: "Sex ratio" },
    "ind.aging_index": { zh: "老化指數", en: "Aging index" },
    "ind.dep_ratio": { zh: "扶養比", en: "Dependency ratio" },
    "ind.child_dep": { zh: "扶幼比", en: "Child dep. ratio" },
    "ind.old_dep": { zh: "扶老比", en: "Old-age dep. ratio" },
    "ind.area_km2": { zh: "面積", en: "Area" },
    "unit.person": { zh: "人", en: "" },
    "unit.household": { zh: "戶", en: "" },
    "unit.person_km2": { zh: "人/km²", en: "/km²" },
    "unit.person_hh": { zh: "人/戶", en: "/hh" },
    "unit.male100f": { zh: "男/百女", en: "M/100F" },

    // 人口面板訊息
    "pop.tip": { zh: "點一個點查村里、畫一塊面查鄉鎮。", en: "Click a point for village, draw an area for township." },
    "pop.loadingVil": { zh: "載入村里資料中…", en: "Loading village data…" },
    "pop.failVil": { zh: "村里資料載入失敗。", en: "Failed to load village data." },
    "pop.outVil": { zh: "此點不在任何村里範圍內。", en: "This point is outside any village." },
    "pop.townNotReady": { zh: "鄉鎮圖資尚未就緒。", en: "Township data not ready." },
    "pop.outTown": { zh: "範圍中心不在任何鄉鎮市區內。", en: "Site centroid is outside any township." },
    "pop.village": { zh: "村里", en: "Village" },
    "pop.town": { zh: "鄉鎮市區", en: "Township" },
    "pop.period": { zh: "人口資料期別(民國):", en: "Population data period: " },
    "pop.sourceMOI": { zh: " · 內政部戶政司", en: " · MOI Household Registration" },

    // 綠地分析
    "g.querySite": { zh: "查詢基地範圍內 OSM 綠地中…", en: "Querying OSM green space within site…" },
    "g.queryRadius": { zh: "查詢 OSM 綠地中…(半徑 {r}m)", en: "Querying OSM green space… (radius {r} m)" },
    "g.siteTitle": { zh: "基地範圍內綠地分析(面積 <b>{a}</b> 公頃)", en: "Green space within site (area <b>{a}</b> ha)" },
    "g.radiusTitle": { zh: "焦點周邊 <b>{r} m</b> 綠地分析", en: "Green space within <b>{r} m</b>" },
    "g.noneRadius": { zh: "周邊 {r}m 內查無 OSM 綠地圖徵(或該區 OSM 標記不全)。", en: "No OSM green features within {r} m (or sparse OSM data here)." },
    "g.hdrParkSite": { zh: "基地內公園(≥0.1ha)", en: "Parks in site (≥0.1 ha)" },
    "g.hdrPark": { zh: "公園(≥0.1ha)", en: "Parks (≥0.1 ha)" },
    "g.hdrIncidSite": { zh: "基地內零星綠地", en: "Incidental green in site" },
    "g.hdrIncid": { zh: "零星綠地(草地 · 小塊)", en: "Incidental green (grass/small)" },
    "g.hdrOverall": { zh: "整體", en: "Overall" },
    "g.nearestDist": { zh: "最近公園距離", en: "Nearest park dist." },
    "g.nearestArea": { zh: "最近公園面積", en: "Nearest park area" },
    "g.park300": { zh: "300m 內公園", en: "Parks within 300m" },
    "g.park500": { zh: "500m 內公園", en: "Parks within 500m" },
    "g.parkArea500": { zh: "公園面積(500m)", en: "Park area (500m)" },
    "g.count": { zh: "處數", en: "Count" },
    "g.area": { zh: "面積", en: "Area" },
    "g.count500": { zh: "500m 內處數", en: "Count within 500m" },
    "g.incidArea": { zh: "零星綠地面積", en: "Incidental green area" },
    "g.greenTotal": { zh: "基地內綠地總面積", en: "Total green in site" },
    "g.coverageAll": { zh: "綠覆率(全綠地)", en: "Green coverage (all)" },
    "g.coverageSite": { zh: "基地綠覆率", en: "Site green coverage" },
    "g.access330": { zh: "3-30-300 可及性", en: "3-30-300 access" },
    "g.noPark": { zh: "最近公園(≥0.1ha)", en: "Nearest park (≥0.1 ha)" },
    "g.noPark500": { zh: "500m 內無", en: "None within 500m" },
    "g.met": { zh: "✓ 達標", en: "✓ Met" },
    "g.notMet": { zh: "✗ 不足", en: "✗ Not met" },
    "g.law": { zh: "法規對照", en: "Regulatory check" },
    "g.law45": { zh: "都市計畫法§45 對照", en: "Urban Planning Act §45" },
    "g.scaleNone": { zh: "周邊 500m 內無 ≥0.1ha 公園", en: "No ≥0.1 ha park within 500m" },
    "g.scaleCommunity": { zh: "最近公園達社區公園規模(≥4ha)", en: "Nearest park ≥ community park (≥4 ha)" },
    "g.scaleNeighbor": { zh: "最近公園達閭鄰公園規模(≥0.5ha)", en: "Nearest park ≥ neighborhood park (≥0.5 ha)" },
    "g.scaleChild": { zh: "最近公園達兒童遊樂場規模(≥0.1ha)", en: "Nearest park ≥ playground (≥0.1 ha)" },
    "g.site10met": { zh: "基地綠覆率 {p}% ✓ 達 10% 參考門檻", en: "Site green coverage {p}% ✓ meets 10% reference" },
    "g.site10no": { zh: "基地綠覆率 {p}% ✗ 未達 10%(註:§45 針對計畫區整體)", en: "Site green coverage {p}% ✗ below 10% (note: §45 applies to the whole plan area)" },
    "g.noteSite": {
      zh: "資料:OpenStreetMap(即時查詢,可能不完整)。綠地面積取與基地範圍相交部分。<br>對照:都市計畫法§45(公園綠地廣場兒童遊樂場合計≥計畫面積10%);綠覆率屬 OSM 下限估計。",
      en: "Data: OpenStreetMap (live, possibly incomplete). Green area is the intersection with the site.<br>Reference: Urban Planning Act §45 (parks/green/plaza/playground ≥10% of plan area); coverage is an OSM lower-bound estimate."
    },
    "g.noteRadius": {
      zh: "資料:OpenStreetMap(即時查詢,可能不完整)。公園=OSM leisure 類且 ≥0.1ha;綠覆率含全部綠地(含零星草地,代理樹冠)。<br>準則:3-30-300(住家 300m 內應有公園/綠地)、通盤檢討辦法(兒童遊樂場≥0.1ha、閭鄰公園≥0.5ha、社區公園≥4ha);都市計畫法§45 合計≥計畫面積10%。",
      en: "Data: OpenStreetMap (live, possibly incomplete). Park = OSM leisure ≥0.1 ha; coverage includes all green (incl. grass, as canopy proxy).<br>Guides: 3-30-300 (park/green within 300m of homes); review rules (playground ≥0.1 ha, neighborhood park ≥0.5 ha, community park ≥4 ha); Urban Planning Act §45 ≥10% of plan area."
    },
    "g.timeout": { zh: "OSM 查詢逾時", en: "OSM query timed out" },
    "g.offline": { zh: "OSM 綠地服務暫時無法連線", en: "OSM green service unavailable" },
    "g.retry": { zh: ",請稍後再試。", en: ", please try again later." },
    "g.km": { zh: " 公頃", en: " ha" },
    "u.m": { zh: "m", en: "m" },
    "u.ha": { zh: "公頃", en: "ha" },
    "u.spot": { zh: "處", en: "" },
    "u.pct": { zh: "%", en: "%" },

    // 熱環境
    "h.title": { zh: "高溫脆弱度研判:<b style='color:{c}'>{lv}</b>", en: "Heat vulnerability: <b style='color:{c}'>{lv}</b>" },
    "h.coverage": { zh: "綠覆率(OSM下限)", en: "Green coverage (OSM min.)" },
    "h.target30": { zh: "對 30% 目標", en: "vs 30% target" },
    "h.elderly": { zh: "高齡比例(65+)", en: "Elderly (65+)" },
    "h.child": { zh: "幼年比例(0-14)", en: "Children (0-14)" },
    "h.lvHigh": { zh: "高", en: "High" },
    "h.lvMid": { zh: "中", en: "Medium" },
    "h.lvLow": { zh: "低", en: "Low" },
    "h.note": {
      zh: "研判方法:綠覆率(OSM 綠地/服務圈面積,屬下限估計)對照 3-30-300 的 30% 樹冠目標,結合高齡與幼年(高溫敏感族群)比例綜合研判。<br>※ 此為依代理指標與實證關聯之<b>研判</b>,非實測健康/氣溫數據。",
      en: "Method: green coverage (OSM green / service-area, lower-bound) vs the 3-30-300 30% canopy target, combined with elderly and child shares (heat-sensitive groups).<br>Note: this is a proxy-based <b>assessment</b>, not measured health/temperature data."
    },

    // 生物多樣性
    "b.querying": { zh: "查詢 iNaturalist 物種紀錄中…(半徑 {r} km)", en: "Querying iNaturalist records… (radius {r} km)" },
    "b.none": { zh: "周邊 {r} km 內查無 iNaturalist 觀測紀錄(該區紀錄可能不足)。", en: "No iNaturalist records within {r} km (data may be sparse here)." },
    "b.title": { zh: "焦點周邊 <b>{r} km</b> 物種紀錄", en: "Species records within <b>{r} km</b>" },
    "b.species": { zh: "物種數", en: "Species" },
    "b.obs": { zh: "觀測筆數", en: "Observations" },
    "b.threat": { zh: "受脅/保育物種", en: "Threatened/protected" },
    "b.unitSp": { zh: "種", en: "" },
    "b.unitObs": { zh: "筆", en: "" },
    "b.topSpecies": { zh: "代表性物種(觀測最多)", en: "Representative species (most observed)" },
    "b.threatList": { zh: "受脅 / 保育物種", en: "Threatened / protected species" },
    "b.taxaHdr": { zh: "分類群物種數", en: "Species by taxon" },
    "b.timeout": { zh: "iNaturalist 查詢逾時", en: "iNaturalist query timed out" },
    "b.offline": { zh: "iNaturalist 服務暫時無法連線", en: "iNaturalist service unavailable" },
    "b.note": {
      zh: "資料:iNaturalist(社群觀測,可驗證紀錄)。代表性物種依觀測次數排序;受脅物種依 IUCN/各地保育名錄標註。<br>※ 觀測涵蓋度依地區與觀察者活動而異,城市公園/校園通常較完整。",
      en: "Data: iNaturalist (community, verifiable observations). Representative species ranked by observation count; threatened species per IUCN/local lists.<br>Note: coverage varies by area and observer activity; parks/campuses are usually better documented."
    },
    "tx.Plantae": { zh: "植物", en: "Plants" },
    "tx.Aves": { zh: "鳥類", en: "Birds" },
    "tx.Insecta": { zh: "昆蟲", en: "Insects" },
    "tx.Mammalia": { zh: "哺乳", en: "Mammals" },
    "tx.Amphibia": { zh: "兩棲", en: "Amphibians" },
    "tx.Reptilia": { zh: "爬蟲", en: "Reptiles" },

    // AI / 匯出 訊息
    "ai.needData": { zh: "請先放標記/畫基地並按「分析周邊綠地」,產生數據後再生成報告。", en: "Place a marker or draw a site and run green-space analysis first, then generate the report." },
    "ai.loading": { zh: "AI 解讀中…(逐步產生)", en: "AI analyzing… (streaming)" },
    "ai.fail": { zh: "AI 解讀暫時無法使用。", en: "AI analysis is temporarily unavailable." },
    "ai.msg": { zh: "訊息:", en: "Message: " },
    "ai.by": { zh: "由 Claude 依本基地真實數值生成", en: "Generated by Claude from this site's real figures" },
    "ai.empty": { zh: "(無內容)", en: "(no content)" },
    "exp.needData": { zh: "請先放標記/畫基地並按「分析周邊綠地」,有數據後再匯出報告。", en: "Run an analysis first, then export the report." },
    "exp.opened": { zh: "已在新分頁開啟報告,於該頁按「列印 / 存 PDF」即可儲存。", en: "Report opened in a new tab; use Print / Save PDF there." },
    "exp.blocked": { zh: "瀏覽器阻擋了新分頁,請允許彈出視窗後再按一次「匯出」。", en: "The browser blocked the new tab; allow pop-ups and click Export again." },
    // 列印報告
    "r.title": { zh: "基地分析報告", en: "Site Analysis Report" },
    "r.coord": { zh: "座標:", en: "Coordinates: " },
    "r.siteArea": { zh: " · 基地面積 ", en: " · Site area " },
    "r.generated": { zh: "產製時間:", en: "Generated: " },
    "r.hPop": { zh: "人口與指標", en: "Population & Indicators" },
    "r.hGreenSite": { zh: "開放空間 · 綠地(基地範圍內)", en: "Open Space · Green (within site)" },
    "r.hGreenRadius": { zh: "開放空間 · 綠地(半徑 {r} m,公園≥0.1ha)", en: "Open Space · Green (radius {r} m, park ≥0.1 ha)" },
    "r.hHeat": { zh: "熱環境 · 健康研判", en: "Heat & Health Assessment" },
    "r.hBiodiv": { zh: "生態 · 生物多樣性(半徑 {r} km)", en: "Ecology · Biodiversity (radius {r} km)" },
    "r.hAI": { zh: "AI 綜合解讀", en: "AI Synthesis" },
    "r.hSrc": { zh: "資料來源與免責", en: "Sources & Disclaimer" },
    "r.met": { zh: "達標", en: "Met" },
    "r.notMet": { zh: "不足", en: "Not met" },
    "r.notMet2": { zh: "未達", en: "Below" },
    "r.siteArea2": { zh: "基地面積", en: "Site area" },
    "r.parkInSite": { zh: "基地內公園(≥0.1ha)", en: "Parks in site (≥0.1 ha)" },
    "r.parkAreaInSite": { zh: "基地內公園面積", en: "Park area in site" },
    "r.incidInSite": { zh: "基地內零星綠地", en: "Incidental green in site" },
    "r.greenInSite": { zh: "基地內綠地總面積", en: "Total green in site" },
    "r.siteCoverage": { zh: "基地綠覆率", en: "Site green coverage" },
    "r.law45ref": { zh: "§45 10% 對照", en: "§45 10% check" },
    "r.nearestDist": { zh: "最近公園距離", en: "Nearest park dist." },
    "r.nearestArea": { zh: "最近公園面積", en: "Nearest park area" },
    "r.p300": { zh: "300m 內公園", en: "Parks within 300m" },
    "r.p500": { zh: "500m 內公園", en: "Parks within 500m" },
    "r.pArea500": { zh: "公園面積(500m)", en: "Park area (500m)" },
    "r.incid500n": { zh: "零星綠地處數(500m)", en: "Incidental green count (500m)" },
    "r.incid500a": { zh: "零星綠地面積(500m)", en: "Incidental green area (500m)" },
    "r.covAll": { zh: "綠覆率(全綠地)", en: "Green coverage (all)" },
    "r.access": { zh: "3-30-300 可及性", en: "3-30-300 access" },
    "r.covOSM": { zh: "綠覆率(OSM下限)", en: "Green coverage (OSM min.)" },
    "r.t30": { zh: "對 30% 目標", en: "vs 30% target" },
    "r.vuln": { zh: "高溫脆弱度", en: "Heat vulnerability" },
    "r.species": { zh: "物種數", en: "Species" },
    "r.obs": { zh: "觀測筆數", en: "Observations" },
    "r.threat": { zh: "受脅/保育物種", en: "Threatened/protected" },
    "r.topSp": { zh: "代表性物種(觀測最多)", en: "Representative species" },
    "r.threatList": { zh: "受脅/保育物種名錄", en: "Threatened/protected list" },
    "r.taxa": { zh: "分類群(植/鳥/蟲…)", en: "Taxa (plants/birds/insects…)" },
    "r.uPerson": { zh: " 人", en: "" },
    "r.uHh": { zh: " 戶", en: "" },
    "r.uPkm2": { zh: " 人/km²", en: " /km²" },
    "r.uHa": { zh: " 公頃", en: " ha" },
    "r.uSpot": { zh: " 處", en: "" },
    "r.uSp": { zh: " 種", en: "" },
    "r.uObs": { zh: " 筆", en: "" },
    "r.aiEmpty": { zh: "(尚未產生 AI 報告)", en: "(AI report not generated yet)" },
    "r.printHint": { zh: "在列印對話框可選「儲存成 PDF」", en: "In the print dialog, choose Save as PDF" },
    "r.src": {
      zh: "底圖:NLSC;界線:NLSC / taiwan-atlas;人口:內政部戶政司 ODRP014(11412);綠地:© OpenStreetMap 貢獻者(ODbL)/ Overpass;地名:OSM Nominatim;生物多樣性:iNaturalist;AI:Anthropic Claude。<br>免責:綠地與綠覆率為即時查詢之下限估計;熱環境/健康為研判而非實測;iNaturalist 觀測涵蓋度依地區而異。本報告僅供規劃參考,不構成正式法定文件。",
      en: "Base: NLSC; boundaries: NLSC / taiwan-atlas; population: MOI ODRP014 (2025-12); green: © OpenStreetMap contributors (ODbL) / Overpass; place: OSM Nominatim; biodiversity: iNaturalist; AI: Anthropic Claude.<br>Disclaimer: green/coverage are live lower-bound estimates; heat/health are assessments, not measurements; iNaturalist coverage varies by area. For planning reference only; not an official document."
    },

    // 工具提示 / 搜尋 / 標記
    "t.markerOn": { zh: "標記模式啟用中:點地圖放置標記,再按一次按鈕結束。", en: "Marker mode on: click the map to drop a marker; click the button again to exit." },
    "t.drawCancel": { zh: "已取消繪製。", en: "Drawing cancelled." },
    "t.drawStart": { zh: "逐點點擊描繪基地範圍,雙擊或點回起點以完成。", en: "Click to add vertices; double-click or click the start point to finish." },
    "t.drawDone": { zh: "基地範圍已完成,面積與所在鄉鎮指標顯示於左側。", en: "Site drawn; area and township indicators shown on the left." },
    "t.cleared": { zh: "已清除所有標記與範圍。", en: "All markers and shapes cleared." },
    "t.marker": { zh: "標記", en: "Marker" },
    "t.lat": { zh: "緯度", en: "Lat" },
    "t.lng": { zh: "經度", en: "Lng" },
    "area.about": { zh: "約 ", en: "≈ " },
    "area.sqm": { zh: " 平方公尺 · ", en: " m² · " },
    "area.shapes": { zh: " 個範圍", en: " shape(s)" },
    "s.needKw": { zh: "請先輸入地名。", en: "Enter a place name first." },
    "s.searching": { zh: "搜尋中…", en: "Searching…" },
    "s.notFound": { zh: "找不到「{q}」,請換個關鍵字試試。", en: "No result for “{q}”; try another keyword." },
    "s.located": { zh: "已定位:", en: "Located: " },
    "s.timeout": { zh: "搜尋逾時", en: "Search timed out" },
    "s.offline": { zh: "搜尋服務暫時無法連線", en: "Search service unavailable" },
    "s.retry2": { zh: "。可改用滑鼠拖曳地圖,或稍後再試。", en: ". Pan the map manually or try again later." },
    "data.none": { zh: "尚無圖資(資料建置中或建置失敗,請稍後重新整理)。", en: "No map data yet (building or failed; please refresh later)." },
    "sp.unnamedPark": { zh: "(未命名公園)", en: "(unnamed park)" },
    "sp.incidental": { zh: "(零星綠地)", en: "(incidental green)" },
    "ai.ghPages": {
      zh: "此頁為 GitHub Pages 靜態預覽,沒有後端,無法執行 AI 解讀。",
      en: "This is a static GitHub Pages preview with no backend; AI analysis is unavailable here."
    },
    "ai.useProd": { zh: "請改用含後端的正式版本:", en: "Use the production version with backend: " },
    "ai.ghOther": { zh: "(其他分析功能在本頁皆可正常使用)", en: "(All other analysis features work on this page.)" }
  };

  // 帶參數的字串:t("key", {r: 500})
  function fmt(s, params) {
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, function (m, k) { return params[k] != null ? params[k] : m; });
  }

  function getLang() {
    var l = localStorage.getItem("lang");
    return l === "en" ? "en" : "zh";
  }
  function setLang(l) {
    localStorage.setItem("lang", l === "en" ? "en" : "zh");
    applyI18n();
    document.documentElement.lang = l === "en" ? "en" : "zh-Hant";
    // 通知 app.js 重繪動態內容
    window.dispatchEvent(new Event("langchange"));
  }
  function t(key, params) {
    var e = DICT[key];
    if (!e) return key;
    return fmt(e[getLang()] || e.zh || key, params);
  }
  function applyI18n() {
    var nodes = document.querySelectorAll("[data-i18n]");
    nodes.forEach(function (n) {
      var key = n.getAttribute("data-i18n");
      n.textContent = t(key);
    });
    var ph = document.querySelectorAll("[data-i18n-ph]");
    ph.forEach(function (n) {
      n.setAttribute("placeholder", t(n.getAttribute("data-i18n-ph")));
    });
  }

  window.t = t;
  window.i18nLang = getLang;
  window.i18nSetLang = setLang;
  window.applyI18n = applyI18n;

  document.addEventListener("DOMContentLoaded", function () {
    document.documentElement.lang = getLang() === "en" ? "en" : "zh-Hant";
    applyI18n();
    var btn = document.getElementById("lang-toggle");
    if (btn) {
      btn.addEventListener("click", function () {
        setLang(getLang() === "en" ? "zh" : "en");
      });
    }
  });
})();
