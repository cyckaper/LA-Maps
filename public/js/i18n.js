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
    "foot": { zh: "© 2026 基地分析工作站 · Site Analysis Studio · 僅供參考", en: "© 2026 Site Analysis Studio · For reference only" },

    "lang.toggle": { zh: "EN", en: "中" }
  };

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
  function t(key) {
    var e = DICT[key];
    if (!e) return key;
    return e[getLang()] || e.zh || key;
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
