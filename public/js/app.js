/* 基地分析工作站 — 第一階段
 * 純 JS + Leaflet + Turf.js + Leaflet.draw
 * 圖磚:內政部國土測繪中心 (NLSC) WMTS
 */
(function () {
  "use strict";

  // ---- 常數 ----
  // NLSC WMTS:GoogleMapsCompatible 等同標準 XYZ,Leaflet 直接可用
  var NLSC_TPL =
    "https://wmts.nlsc.gov.tw/wmts/{layer}/default/GoogleMapsCompatible/{z}/{y}/{x}";
  var NLSC_ATTR = "圖磚 © 內政部國土測繪中心 (NLSC)";

  // 預設視野:台北 · 台灣大學附近
  var DEFAULT_CENTER = [25.0174, 121.5398];
  var DEFAULT_ZOOM = 16;

  function nlscLayer(layer, opts) {
    opts = opts || {};
    return L.tileLayer(NLSC_TPL.replace("{layer}", layer), {
      maxZoom: 20,
      minZoom: 6,
      attribution: NLSC_ATTR,
      opacity: opts.opacity != null ? opts.opacity : 1
    });
  }

  // ---- 地圖初始化 ----
  var map = L.map("map", {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: true
  });

  // 視窗縮放/旋轉時讓地圖重算尺寸,避免圖磚只填半屏
  function refreshMapSize() {
    map.invalidateSize();
  }
  window.addEventListener("resize", refreshMapSize);
  window.addEventListener("orientationchange", function () {
    setTimeout(refreshMapSize, 250);
  });

  // 底圖
  var baseLayers = {
    EMAP: nlscLayer("EMAP"),
    PHOTO_MIX: nlscLayer("PHOTO_MIX"), // 正射影像 + 道路/地名註記套疊
    PHOTO2: nlscLayer("PHOTO2")
  };
  var currentBase = "EMAP";
  baseLayers.EMAP.addTo(map);

  // 疊圖圖層(NLSC WMTS + 地質調查所 WMS,可多選 + 共用透明度)
  var GEO_WMS = "https://geomap.gsmma.gov.tw/mapguide/mapagent/mapagent.fcgi";
  var overlayOpacity = 0.55;

  function warnOverlay(id) {
    var w = document.getElementById("ovwarn-" + id);
    if (w) w.textContent = t("ov.warn");
  }

  // NLSC 圖磚疊圖(標準 XYZ tile)
  function nlscOverlay(layerId, def) {
    var layer = nlscLayer(layerId, { opacity: overlayOpacity });
    layer.on("tileerror", function () { warnOverlay(def.id); });
    return {
      active: false,
      add: function () { layer.addTo(map); layer.bringToFront(); this.active = true; },
      remove: function () { map.removeLayer(layer); this.active = false; },
      setOpacity: function (o) { layer.setOpacity(o); },
      front: function () { if (map.hasLayer(layer)) layer.bringToFront(); }
    };
  }

  // 地質 WMS:改用「單張影像疊圖」(複製確認可用的 GetMap 請求),
  // 避免 Leaflet 切磚式 WMS 在 MapGuide 回空白圖磚
  function geoOverlay(layerName, def) {
    var img = null;
    var self = { active: false };
    function refresh() {
      if (!self.active) return;
      var b = map.getBounds(), s = map.getSize();
      var url = GEO_WMS + "?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=" +
        "&CRS=EPSG:4326&FORMAT=image/png&TRANSPARENT=true" +
        "&WIDTH=" + s.x + "&HEIGHT=" + s.y +
        "&LAYERS=" + encodeURIComponent(layerName) +
        "&BBOX=" + b.getSouth() + "," + b.getWest() + "," + b.getNorth() + "," + b.getEast();
      if (img) map.removeLayer(img);
      img = L.imageOverlay(url, b, { opacity: overlayOpacity, interactive: false });
      img.on("error", function () { warnOverlay(def.id); });
      img.addTo(map);
    }
    self.add = function () { self.active = true; refresh(); map.on("moveend", refresh); };
    self.remove = function () {
      self.active = false; map.off("moveend", refresh);
      if (img) { map.removeLayer(img); img = null; }
    };
    self.setOpacity = function (o) { if (img) img.setOpacity(o); };
    self.front = function () { if (img) img.bringToFront(); };
    return self;
  }

  var OVERLAY_DEFS = [
    { id: "LUIMAP", label: "國土利用調查(綠地/土地利用)", type: "nlsc" },
    { id: "SCHOOL", label: "各級學校範圍(學區)", type: "nlsc" },
    { id: "LANDSECT", label: "段籍圖(地籍)", type: "nlsc" },
    { id: "LIQUEFACTION", label: "土壤液化潛勢", type: "geo", layer: "WMS/Geomap_Envi_Soil_liquefatcion_2021" },
    { id: "FAULT", label: "活動斷層分布線(2021)", type: "geo", layer: "WMS/25K_Geomap_fault_2021" },
    { id: "FAULT_ZONE", label: "活動斷層地質敏感區(帶狀)", type: "geo", layer: "WMS/Sensitive_area_fault" }
  ];
  var overlays = {};
  OVERLAY_DEFS.forEach(function (def) {
    overlays[def.id] = def.type === "geo"
      ? geoOverlay(def.layer, def)
      : nlscOverlay(def.id, def);
  });
  function bringOverlaysToFront() {
    OVERLAY_DEFS.forEach(function (def) {
      if (overlays[def.id].active) overlays[def.id].front();
    });
  }

  // ---- 圖層群組 ----
  var markersGroup = L.layerGroup().addTo(map);
  var drawnItems = new L.FeatureGroup().addTo(map);

  // 最近一次分析焦點(放標記或畫基地時更新),供綠地分析使用
  var lastFocus = null;
  // 最近一次畫的基地多邊形(GeoJSON);有值時綠地分析改為「範圍內」模式
  var lastSitePolygon = null;
  // 最近一次對應到的行政區指標(供熱環境/健康研判使用)
  var lastRegionProps = null;
  // 最近一次基地面積(公頃)與彙整分析資料(供 AI 解讀使用)
  var lastSiteAreaHa = null;
  var lastAnalysis = null;
  var lastRegionTitle = "";
  var lastBiodiv = null;

  // =========================================================
  //  底圖切換
  // =========================================================
  document.getElementById("basemap-group").addEventListener("change", function (e) {
    if (e.target.name !== "basemap") return;
    var next = e.target.value;
    if (next === currentBase) return;
    map.removeLayer(baseLayers[currentBase]);
    baseLayers[next].addTo(map);
    // 確保疊圖保持在底圖之上
    bringOverlaysToFront();
    currentBase = next;
  });

  // =========================================================
  //  疊圖圖層清單 + 共用透明度
  // =========================================================
  var overlayListEl = document.getElementById("overlay-list");
  OVERLAY_DEFS.forEach(function (def) {
    var row = document.createElement("label");
    row.className = "switch-row";
    row.innerHTML = "<input type='checkbox' data-ov='" + def.id + "'> " +
      "<span class='ov-label' data-ovkey='ov." + def.id + "'>" + t("ov." + def.id) + "</span>" +
      " <span class='ovwarn' id='ovwarn-" + def.id + "'></span>";
    overlayListEl.appendChild(row);
  });
  overlayListEl.addEventListener("change", function (e) {
    var id = e.target.getAttribute && e.target.getAttribute("data-ov");
    if (!id) return;
    var rec = overlays[id];
    if (e.target.checked) { rec.add(); } else { rec.remove(); }
  });

  var ovOpacity = document.getElementById("ov-opacity");
  var ovOpacityVal = document.getElementById("ov-opacity-val");
  ovOpacity.addEventListener("input", function () {
    overlayOpacity = parseFloat(ovOpacity.value);
    ovOpacityVal.textContent = overlayOpacity.toFixed(2);
    OVERLAY_DEFS.forEach(function (def) { overlays[def.id].setOpacity(overlayOpacity); });
  });

  // =========================================================
  //  工具:標記 / 多邊形 / 清除
  // =========================================================
  var toolMarkerBtn = document.getElementById("tool-marker");
  var toolPolygonBtn = document.getElementById("tool-polygon");
  var toolClearBtn = document.getElementById("tool-clear");
  var toolHint = document.getElementById("tool-hint");

  var markerMode = false;
  var polygonDrawer = null;

  function setMarkerBtnState(active) {
    toolMarkerBtn.classList.toggle("active", active);
  }
  function setPolygonBtnState(active) {
    toolPolygonBtn.classList.toggle("active", active);
  }

  // --- 標記模式 ---
  function enableMarkerMode() {
    if (markerMode) {
      disableMarkerMode();
      return;
    }
    cancelPolygonDraw();
    markerMode = true;
    setMarkerBtnState(true);
    map.getContainer().style.cursor = "crosshair";
    toolHint.textContent = t("t.markerOn");
  }
  function disableMarkerMode() {
    markerMode = false;
    setMarkerBtnState(false);
    map.getContainer().style.cursor = "";
    toolHint.textContent = t("tools.hint");
  }

  toolMarkerBtn.addEventListener("click", enableMarkerMode);

  map.on("click", function (e) {
    if (!markerMode) return;
    var m = L.marker(e.latlng).addTo(markersGroup);
    m.bindPopup(
      t("t.marker") + "<br>" + t("t.lat") + " " +
        e.latlng.lat.toFixed(5) +
        "<br>" + t("t.lng") + " " +
        e.latlng.lng.toFixed(5)
    ).openPopup();
    lastFocus = e.latlng;
    lastSitePolygon = null; // 點模式
    // 點 → 查村里人口指標
    lookupVillage(e.latlng.lat, e.latlng.lng);
  });

  // --- 多邊形繪製 ---
  function cancelPolygonDraw() {
    if (polygonDrawer) {
      polygonDrawer.disable();
      polygonDrawer = null;
    }
    setPolygonBtnState(false);
  }

  toolPolygonBtn.addEventListener("click", function () {
    if (polygonDrawer) {
      cancelPolygonDraw();
      toolHint.textContent = t("t.drawCancel");
      return;
    }
    disableMarkerMode();
    polygonDrawer = new L.Draw.Polygon(map, {
      shapeOptions: { color: "#3ba88f", weight: 2, fillOpacity: 0.2 },
      allowIntersection: false,
      showArea: false
    });
    polygonDrawer.enable();
    setPolygonBtnState(true);
    toolHint.textContent = t("t.drawStart");
  });

  map.on(L.Draw.Event.CREATED, function (e) {
    drawnItems.addLayer(e.layer);
    polygonDrawer = null;
    setPolygonBtnState(false);
    computeArea();
    toolHint.textContent = t("t.drawDone");
    // 面 → 取範圍中心,查所在鄉鎮市區指標
    try {
      var c = turf.centroid(e.layer.toGeoJSON());
      var xy = c.geometry.coordinates; // [lng, lat]
      lastFocus = L.latLng(xy[1], xy[0]);
      lastSitePolygon = e.layer.toGeoJSON(); // 面模式:分析範圍內綠地
      lookupTown(xy[1], xy[0]);
    } catch (err) {
      /* 忽略 */
    }
  });

  map.on(L.Draw.Event.DRAWSTOP, function () {
    setPolygonBtnState(false);
  });

  // --- 面積計算(公頃)---
  var areaValueEl = document.getElementById("area-value");
  var areaDetailEl = document.getElementById("area-detail");

  function computeArea() {
    var totalSqm = 0;
    var count = 0;
    drawnItems.eachLayer(function (layer) {
      if (typeof layer.getLatLngs !== "function") return;
      var gj = layer.toGeoJSON();
      try {
        totalSqm += turf.area(gj);
        count++;
      } catch (err) {
        /* 忽略無法計算的圖形 */
      }
    });

    if (count === 0) {
      areaValueEl.textContent = "—";
      areaDetailEl.textContent = "";
      lastSiteAreaHa = null;
      return;
    }
    lastSiteAreaHa = +(totalSqm / 10000).toFixed(2);
    var ha = totalSqm / 10000;
    areaValueEl.textContent = ha.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    areaDetailEl.textContent =
      t("area.about") +
      Math.round(totalSqm).toLocaleString() +
      t("area.sqm") +
      count +
      t("area.shapes");
  }

  // --- 清除 ---
  toolClearBtn.addEventListener("click", function () {
    markersGroup.clearLayers();
    drawnItems.clearLayers();
    cancelPolygonDraw();
    disableMarkerMode();
    computeArea();
    resetInfoPanel();
    lastFocus = null;
    lastSitePolygon = null;
    lastBiodiv = null;
    resetGreenPanel();
    resetBiodivPanel();
    toolHint.textContent = t("t.cleared");
  });

  // =========================================================
  //  地名搜尋 (Nominatim) + 退回處理
  // =========================================================
  var searchForm = document.getElementById("search-form");
  var searchInput = document.getElementById("search-input");
  var searchStatus = document.getElementById("search-status");
  var searchMarker = null;

  function setStatus(msg, kind) {
    searchStatus.textContent = msg;
    searchStatus.className = "status" + (kind ? " " + kind : "");
  }

  function fetchWithTimeout(url, ms, opts) {
    opts = opts || {};
    var init = {
      method: opts.method || "GET",
      headers: opts.headers || { Accept: "application/json" }
    };
    if (opts.body != null) init.body = opts.body;
    if (typeof AbortController === "undefined") {
      return fetch(url, init); // 舊瀏覽器退回,無逾時控制
    }
    var ctrl = new AbortController();
    var t = setTimeout(function () {
      ctrl.abort();
    }, ms);
    init.signal = ctrl.signal;
    return fetch(url, init).finally(function () {
      clearTimeout(t);
    });
  }

  searchForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = searchInput.value.trim();
    if (!q) {
      setStatus(t("s.needKw"), "error");
      return;
    }
    setStatus(t("s.searching"), null);

    // 偏向台灣結果
    var url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=tw&accept-language=zh-TW&q=" +
      encodeURIComponent(q);

    fetchWithTimeout(url, 8000)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || data.length === 0) {
          setStatus(t("s.notFound", {q: q}), "error");
          return;
        }
        var hit = data[0];
        var lat = parseFloat(hit.lat);
        var lon = parseFloat(hit.lon);
        map.setView([lat, lon], 16);

        if (searchMarker) markersGroup.removeLayer(searchMarker);
        searchMarker = L.marker([lat, lon]).addTo(markersGroup);
        searchMarker
          .bindPopup("<b>" + (hit.display_name || q) + "</b>")
          .openPopup();
        setStatus(t("s.located") + (hit.display_name || q), "ok");
      })
      .catch(function (err) {
        // 連線失敗 / 逾時 / 被阻擋 的退回處理
        var aborted = err && err.name === "AbortError";
        setStatus(
          (aborted ? t("s.timeout") : t("s.offline")) + t("s.retry2"),
          "error"
        );
      });
  });

  // =========================================================
  //  第二階段:人口空間對應(點→村里、面→鄉鎮)
  //  資料由 GitHub Actions 於建置時產生於 ./data/
  // =========================================================
  var DATA = {
    towns: null, townsIdx: null,
    villages: null, villagesIdx: null,
    meta: null, villagesLoading: null
  };

  var infoRegionEl = document.getElementById("info-region");
  var indicatorsEl = document.getElementById("indicators");
  var infoSourceEl = document.getElementById("info-source");

  var INDICATOR_DEFS = [
    { key: "pop", unitKey: "unit.person", int: true },
    { key: "households", unitKey: "unit.household", int: true },
    { key: "density", unitKey: "unit.person_km2" },
    { key: "household_size", unitKey: "unit.person_hh" },
    { key: "sex_ratio", unitKey: "unit.male100f" },
    { key: "aging_index", unitKey: "" },
    { key: "dep_ratio", unit: "%" },
    { key: "child_dep", unit: "%" },
    { key: "old_dep", unit: "%" },
    { key: "area_km2", unit: "km²" }
  ];

  function fmtVal(v, def) {
    if (v == null || v === "") return "—";
    if (def.int) return Math.round(v).toLocaleString();
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // 保存最近一次的人口資料,語言切換時可重繪
  var lastRegionTitleHtml = "";

  function resetInfoPanel() {
    lastRegionProps = null;
    lastRegionTitleHtml = "";
    infoRegionEl.textContent = t("pop.tip");
    indicatorsEl.innerHTML = "";
    infoSourceEl.textContent = "";
  }

  function renderIndicators(props, titleHtml) {
    lastRegionProps = props;
    lastRegionTitleHtml = titleHtml;
    lastRegionTitle = titleHtml.replace(/<[^>]+>/g, "").trim();
    infoRegionEl.innerHTML = titleHtml;
    var html = "";
    for (var i = 0; i < INDICATOR_DEFS.length; i++) {
      var d = INDICATOR_DEFS[i];
      var val = props ? props[d.key] : null;
      var unit = d.unitKey ? t(d.unitKey) : (d.unit || "");
      html +=
        "<div class='ind'><dt>" + t("ind." + d.key) + "</dt><dd>" +
        fmtVal(val, d) +
        (unit ? " <span class='u'>" + unit + "</span>" : "") +
        "</dd></div>";
    }
    indicatorsEl.innerHTML = html;
    var period = DATA.meta && DATA.meta.population_period;
    if (props && props.pop != null) {
      infoSourceEl.textContent = t("pop.period") + (period || "—") + t("pop.sourceMOI");
    } else {
      infoSourceEl.textContent = "";
    }
  }

  function buildIndex(fc) {
    var idx = [];
    for (var i = 0; i < fc.features.length; i++) {
      var f = fc.features[i];
      try {
        idx.push({ f: f, bbox: turf.bbox(f) });
      } catch (e) {
        /* 略過異常幾何 */
      }
    }
    return idx;
  }

  // 點位落在哪個多邊形(bbox 預篩 + 精確判斷)
  function locate(lng, lat, idx) {
    for (var i = 0; i < idx.length; i++) {
      var b = idx[i].bbox;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      try {
        if (turf.booleanPointInPolygon([lng, lat], idx[i].f)) return idx[i].f;
      } catch (e) {
        /* 略過 */
      }
    }
    return null;
  }

  function loadJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  // 啟動:載入鄉鎮界線 + meta(村里檔較大,延後到首次需要時才載)
  Promise.all([
    loadJSON("./data/towns.json").catch(function () { return null; }),
    loadJSON("./data/meta.json").catch(function () { return null; })
  ]).then(function (res) {
    DATA.towns = res[0];
    DATA.meta = res[1];
    if (DATA.towns) {
      DATA.townsIdx = buildIndex(DATA.towns);
      resetInfoPanel();
    } else {
      infoRegionEl.textContent =
        t("data.none");
    }
  });

  function ensureVillages() {
    if (DATA.villagesIdx) return Promise.resolve(true);
    if (DATA.villagesLoading) return DATA.villagesLoading;
    infoRegionEl.textContent = t("pop.loadingVil");
    DATA.villagesLoading = loadJSON("./data/villages.json")
      .then(function (fc) {
        DATA.villages = fc;
        DATA.villagesIdx = buildIndex(fc);
        return true;
      })
      .catch(function () {
        infoRegionEl.textContent = t("pop.failVil");
        return false;
      });
    return DATA.villagesLoading;
  }

  function lookupVillage(lat, lng) {
    ensureVillages().then(function (ok) {
      if (!ok || !DATA.villagesIdx) return;
      var f = locate(lng, lat, DATA.villagesIdx);
      if (!f) {
        infoRegionEl.textContent = t("pop.outVil");
        indicatorsEl.innerHTML = "";
        return;
      }
      var p = f.properties;
      renderIndicators(
        p,
        t("pop.village") + " · " + (p.COUNTYNAME || "") + (p.TOWNNAME || "") +
          " <b>" + (p.VILLNAME || "") + "</b>"
      );
    });
  }

  function lookupTown(lat, lng) {
    if (!DATA.townsIdx) {
      infoRegionEl.textContent = t("pop.townNotReady");
      return;
    }
    var f = locate(lng, lat, DATA.townsIdx);
    if (!f) {
      infoRegionEl.textContent = t("pop.outTown");
      indicatorsEl.innerHTML = "";
      return;
    }
    var p = f.properties;
    renderIndicators(
      p,
      t("pop.town") + " · " + (p.COUNTYNAME || "") + " <b>" + (p.TOWNNAME || "") + "</b>"
    );
  }

  // =========================================================
  //  第三階段 3a:開放空間 / 綠地可及性(OSM Overpass,瀏覽器即時查)
  // =========================================================
  var greenBtn = document.getElementById("green-btn");
  var greenRegionEl = document.getElementById("green-region");
  var greenIndEl = document.getElementById("green-indicators");
  var greenSourceEl = document.getElementById("green-source");
  var heatRegionEl = document.getElementById("heat-region");
  var heatIndEl = document.getElementById("heat-indicators");
  var heatSourceEl = document.getElementById("heat-source");
  var climateRegionEl = document.getElementById("climate-region");
  var climateIndEl = document.getElementById("climate-indicators");
  var climateSourceEl = document.getElementById("climate-source");

  var OVERPASS = "https://overpass-api.de/api/interpreter";
  var GREEN_RADIUS = 500; // 公尺:服務圈半徑
  var MIN_PARK_M2 = 1000; // 有效公園最小面積(0.1 公頃,兒童遊樂場法定最小規模)
  var greenMarkers = L.layerGroup().addTo(map);

  // Open-Meteo Archive(ERA5):免金鑰、支援瀏覽器 CORS;取近年逐日資料計算氣候背景值
  var OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
  var CLIMATE_REF_START = "2020-01-01"; // 氣候參考期(5 個完整年,平滑單年異常)
  var CLIMATE_REF_END = "2024-12-31";
  var HEAT_DAY_TMAX_C = 32; // 高溫日門檻:單日最高溫 ≥ 32°C

  function resetGreenPanel() {
    greenRegionEl.textContent = t("green.hint");
    greenIndEl.innerHTML = "";
    greenSourceEl.textContent = "";
    greenMarkers.clearLayers();
    heatRegionEl.textContent = t("heat.hint");
    heatIndEl.innerHTML = "";
    heatSourceEl.textContent = "";
    climateRegionEl.textContent = t("climate.hint");
    climateIndEl.innerHTML = "";
    climateSourceEl.textContent = "";
  }

  // 熱環境/健康研判:綠覆率(對 3-30-300 的 30% 目標)× 脆弱族群(高齡+幼年)
  function renderHeat(greenCoveragePct, props) {
    var elderly = props && props.elderly_share != null ? props.elderly_share : null;
    var child = props && props.child_share != null ? props.child_share : null;
    var greenDeficit = Math.max(0, Math.min(1, (30 - greenCoveragePct) / 30)); // 0..1
    var vulnShare = elderly != null && child != null ? (elderly + child) / 100 : null;
    var vulnNorm = vulnShare != null ? Math.min(1, vulnShare / 0.4) : null; // 40% 視為高
    var heat = vulnNorm != null ? 0.5 * greenDeficit + 0.5 * vulnNorm : greenDeficit;
    var levelKey = heat > 0.66 ? "h.lvHigh" : heat > 0.34 ? "h.lvMid" : "h.lvLow";
    var level = t(levelKey);
    var color = heat > 0.66 ? "#d56456" : heat > 0.34 ? "#d8a657" : "#45c2a4";

    heatRegionEl.innerHTML = t("h.title", { c: color, lv: level });
    var html = "";
    html += ind(t("h.coverage"), greenCoveragePct.toFixed(1), "%");
    html += ind(t("h.target30"), (greenCoveragePct >= 30 ? t("g.met") : t("g.notMet")), "");
    html += ind(t("h.elderly"), elderly != null ? elderly.toFixed(1) : "—", "%");
    html += ind(t("h.child"), child != null ? child.toFixed(1) : "—", "%");
    heatIndEl.innerHTML = html;

    heatSourceEl.innerHTML = t("h.note");
    // 儲存原始 level 鍵供其他語言參考(英文/中文皆存可讀字)
    if (lastAnalysis) {
      lastAnalysis.heat = {
        green_coverage_pct: +greenCoveragePct.toFixed(1),
        meets_30pct_target: greenCoveragePct >= 30,
        elderly_share: elderly,
        child_share: child,
        vulnerability_level: level
      };
    }
  }

  // ---- 氣候背景(Open-Meteo ERA5)----
  function avg(arr) {
    return arr.length ? arr.reduce(function (s, v) { return s + v; }, 0) / arr.length : 0;
  }

  // 依基地中心點向 Open-Meteo Archive 查近年逐日資料,計算氣候背景值
  function loadClimate(lat, lng) {
    climateRegionEl.textContent = t("cl.loading");
    climateIndEl.innerHTML = "";
    climateSourceEl.textContent = "";
    var params =
      "latitude=" + lat.toFixed(4) + "&longitude=" + lng.toFixed(4) +
      "&start_date=" + CLIMATE_REF_START + "&end_date=" + CLIMATE_REF_END +
      "&daily=temperature_2m_mean,temperature_2m_max,precipitation_sum," +
      "wind_direction_10m_dominant,shortwave_radiation_sum" +
      "&timezone=auto";
    var url = OPEN_METEO_ARCHIVE + "?" + params;

    fetchWithTimeout(url, 25000)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) { renderClimate(data); })
      .catch(function (err) {
        var aborted = err && err.name === "AbortError";
        climateRegionEl.textContent = aborted ? t("cl.timeout") : t("cl.offline");
        climateSourceEl.textContent = "";
      });
  }

  function renderClimate(data) {
    var d = (data && data.daily) || {};
    var time = d.time || [];
    var tmean = d.temperature_2m_mean || [];
    var tmax = d.temperature_2m_max || [];
    var precip = d.precipitation_sum || [];
    var wdir = d.wind_direction_10m_dominant || [];
    var rad = d.shortwave_radiation_sum || [];
    if (!time.length) { climateRegionEl.textContent = t("cl.nodata"); return; }

    // 參考期內年數(平均年值用)
    var yearSet = {};
    time.forEach(function (s) { yearSet[s.slice(0, 4)] = true; });
    var nYears = Object.keys(yearSet).length || 1;

    // 年均溫
    var annualMean = avg(tmean.filter(function (v) { return v != null; }));

    // 最熱月(逐月平均溫取最大)
    var monSum = {}, monN = {};
    time.forEach(function (s, i) {
      var m = s.slice(5, 7), v = tmean[i];
      if (v == null) return;
      monSum[m] = (monSum[m] || 0) + v; monN[m] = (monN[m] || 0) + 1;
    });
    var hotMon = null, hotVal = -Infinity;
    Object.keys(monSum).forEach(function (m) {
      var a = monSum[m] / monN[m];
      if (a > hotVal) { hotVal = a; hotMon = m; }
    });

    // 年降雨量(總和 / 年數)
    var annualPrecip = precip.reduce(function (s, v) { return s + (v || 0); }, 0) / nYears;

    // 高溫日數 / 年(單日最高溫 ≥ 門檻)
    var heatDaysYr =
      tmax.filter(function (v) { return v != null && v >= HEAT_DAY_TMAX_C; }).length / nYears;

    // 盛行風向(來向,8 方位取眾數)
    var sectors = [0, 0, 0, 0, 0, 0, 0, 0];
    wdir.forEach(function (v) { if (v == null) return; sectors[Math.round(v / 45) % 8]++; });
    var domIdx = sectors.indexOf(Math.max.apply(null, sectors));
    var dirKeys = ["cl.N", "cl.NE", "cl.E", "cl.SE", "cl.S", "cl.SW", "cl.W", "cl.NW"];
    var dirLabel = t(dirKeys[domIdx]);

    // 日均日射量(MJ/m²)
    var avgRad = avg(rad.filter(function (v) { return v != null; }));

    climateRegionEl.innerHTML = t("cl.title", { y: nYears });
    var html = "";
    html += ind(t("cl.annualMean"), annualMean.toFixed(1), "°C");
    html += ind(t("cl.hottest"), t("cl.mon" + hotMon) + " " + hotVal.toFixed(1), "°C");
    html += ind(t("cl.heatDays"), heatDaysYr.toFixed(0), t("cl.daysYr"));
    html += ind(t("cl.precip"), annualPrecip.toFixed(0), "mm");
    html += ind(t("cl.wind"), dirLabel, "");
    html += ind(t("cl.solar"), avgRad.toFixed(1), "MJ/m²");
    climateIndEl.innerHTML = html;
    climateSourceEl.innerHTML = t("cl.note", {
      s: CLIMATE_REF_START.slice(0, 4), e: CLIMATE_REF_END.slice(0, 4)
    });

    if (lastAnalysis) {
      lastAnalysis.climate = {
        source: "Open-Meteo ERA5",
        reference_period: CLIMATE_REF_START.slice(0, 4) + "-" + CLIMATE_REF_END.slice(0, 4),
        annual_mean_temp_c: +annualMean.toFixed(1),
        hottest_month: hotMon,
        hottest_month_mean_c: +hotVal.toFixed(1),
        heat_days_per_year_ge32c: +heatDaysYr.toFixed(0),
        annual_precip_mm: +annualPrecip.toFixed(0),
        dominant_wind_dir: dirLabel,
        avg_daily_solar_mj_m2: +avgRad.toFixed(1)
      };
    }
  }

  // 把 Overpass element(way 或 relation)轉成一個或多個帶屬性的 turf polygon
  function elToPolygons(el) {
    var tags = el.tags || {};
    var category = tags.leisure ? "park" : "green";
    var name = tags.name || tags["name:zh"] || (tags.leisure ? t("sp.unnamedPark") : t("sp.incidental"));
    var out = [];

    function pushRing(geom) {
      if (!geom || geom.length < 4) return;
      var ring = geom.map(function (p) { return [p.lon, p.lat]; });
      var f = ring[0], l = ring[ring.length - 1];
      if (f[0] !== l[0] || f[1] !== l[1]) ring.push(f);
      if (ring.length < 4) return;
      try {
        var poly = turf.polygon([ring]);
        poly.properties = { name: name, category: category, area_m2: turf.area(poly) };
        out.push(poly);
      } catch (e) { /* 跳過無效環 */ }
    }

    if (el.type === "way") {
      pushRing(el.geometry);
    } else if (el.type === "relation" && el.members) {
      // 多邊形 relation:取所有 outer 環各自成面(忽略 inner 洞,面積略為高估但足供估算)
      el.members.forEach(function (m) {
        if (m.type === "way" && m.geometry && (m.role === "outer" || !m.role)) pushRing(m.geometry);
      });
    }
    return out;
  }

  function nearestDist(focusPt, park) {
    try {
      if (turf.booleanPointInPolygon(focusPt, park)) return 0;
      var ring = park.geometry.coordinates[0];
      return turf.pointToLineDistance(focusPt, turf.lineString(ring), { units: "meters" });
    } catch (e) {
      try { return turf.distance(focusPt, turf.centroid(park), { units: "meters" }); }
      catch (e2) { return Infinity; }
    }
  }

  function ind(label, value, unit) {
    return "<div class='ind'><dt>" + label + "</dt><dd>" + value +
      (unit ? " <span class='u'>" + unit + "</span>" : "") + "</dd></div>";
  }

  // 基地範圍內綠地分析:查基地外接框內綠地,取與基地相交面積
  function analyzeGreenSite(sitePoly) {
    var bb = turf.bbox(sitePoly); // [minX,minY,maxX,maxY] = [W,S,E,N]
    var siteAreaM2 = turf.area(sitePoly);
    greenRegionEl.textContent = t("g.querySite");
    greenIndEl.innerHTML = "";
    greenSourceEl.textContent = "";

    var le = '["leisure"~"^(park|garden|recreation_ground|nature_reserve|playground)$"]';
    var lu = '["landuse"~"^(grass|forest|meadow|greenfield|village_green)$"]';
    var bbox = "(" + bb[1] + "," + bb[0] + "," + bb[3] + "," + bb[2] + ")";
    // 同時查 way 與 relation(多邊形公園常是 relation),relation 取外環幾何
    var q = "[out:json][timeout:25];(" +
      "way" + le + bbox + ";" + "relation" + le + bbox + ";" +
      "way" + lu + bbox + ";" + "relation" + lu + bbox + ";" +
      ");out geom;";
    var url = OVERPASS + "?data=" + encodeURIComponent(q);

    fetchWithTimeout(url, 25000)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        var parks = [], incid = [], parkM2 = 0, incidM2 = 0, greenM2 = 0;
        (data.elements || []).forEach(function (el) {
          elToPolygons(el).forEach(function (poly) {
            var clip = null;
            try { clip = turf.intersect(poly, sitePoly); } catch (e) { clip = null; }
            // intersect 失敗時退回:只要與基地相交就計入,面積取較小者(估算)
            if (!clip) {
              var overlaps = false;
              try { overlaps = turf.booleanIntersects(poly, sitePoly); } catch (e) { overlaps = false; }
              if (!overlaps) return; // 真的不相交
            }
            var a = 0;
            try { a = clip ? turf.area(clip) : Math.min(poly.properties.area_m2, siteAreaM2); }
            catch (e) { a = 0; }
            if (a <= 0) return;
            poly.properties.clip_area_m2 = a;
            greenM2 += a;
            if (poly.properties.category === "park" && poly.properties.area_m2 >= MIN_PARK_M2) {
              parks.push(poly); parkM2 += a;
            } else {
              incid.push(poly); incidM2 += a;
            }
          });
        });

        greenMarkers.clearLayers();
        L.geoJSON(sitePoly, { style: { color: "#3ba88f", weight: 2, fill: false, dashArray: "4" } }).addTo(greenMarkers);
        parks.concat(incid).forEach(function (f) {
          var isPark = f.properties.category === "park" && f.properties.area_m2 >= MIN_PARK_M2;
          L.geoJSON(f, {
            style: isPark
              ? { color: "#1f6b46", weight: 1.5, fillColor: "#2e8b57", fillOpacity: 0.45 }
              : { color: "#7fae8e", weight: 0.5, fillColor: "#9cc8aa", fillOpacity: 0.25 }
          }).bindPopup(
            (isPark ? "🏞 " : "") + (f.properties.name || "") + "<br>" +
            (f.properties.clip_area_m2 / 10000).toFixed(2) + t("u.ha")).addTo(greenMarkers);
        });

        var siteHa = siteAreaM2 / 10000;
        var coverage = siteAreaM2 > 0 ? (greenM2 / siteAreaM2) * 100 : 0;
        var meets10 = coverage >= 10;

        greenRegionEl.innerHTML = t("g.siteTitle", { a: siteHa.toFixed(2) });
        var ghdr = function (s) { return "<div class='ghdr' style='grid-column:1/-1'>" + s + "</div>"; };
        var html = "";
        html += ghdr(t("g.hdrParkSite"));
        html += ind(t("g.count"), parks.length, t("u.spot"));
        html += ind(t("g.area"), (parkM2 / 10000).toFixed(2), t("u.ha"));
        html += ghdr(t("g.hdrIncidSite"));
        html += ind(t("g.count"), incid.length, t("u.spot"));
        html += ind(t("g.area"), (incidM2 / 10000).toFixed(2), t("u.ha"));
        html += ghdr(t("g.hdrOverall"));
        html += ind(t("g.greenTotal"), (greenM2 / 10000).toFixed(2), t("u.ha"));
        html += ind(t("g.coverageSite"), coverage.toFixed(1), "%");
        html += "<div class='ind' style='grid-column:1/-1'><dt>" + t("g.law45") + "</dt><dd style='font-size:12px;font-weight:400'>" +
          (meets10 ? t("g.site10met", { p: coverage.toFixed(1) }) : t("g.site10no", { p: coverage.toFixed(1) })) +
          "</dd></div>";
        greenIndEl.innerHTML = html;

        lastAnalysis = {
          focus: { lat: +((bb[1] + bb[3]) / 2).toFixed(5), lng: +((bb[0] + bb[2]) / 2).toFixed(5) },
          site_area_ha: +siteHa.toFixed(2),
          population: lastRegionProps,
          green: {
            mode: "within_site",
            site_area_ha: +siteHa.toFixed(2),
            park_count_in_site: parks.length,
            park_area_in_site_ha: +(parkM2 / 10000).toFixed(2),
            incidental_count_in_site: incid.length,
            green_area_in_site_ha: +(greenM2 / 10000).toFixed(2),
            site_green_coverage_pct: +coverage.toFixed(1),
            meets_10pct_ref: meets10
          }
        };
        renderHeat(coverage, lastRegionProps);
        loadClimate((bb[1] + bb[3]) / 2, (bb[0] + bb[2]) / 2);

        greenSourceEl.innerHTML = t("g.noteSite");
      })
      .catch(function (err) {
        var aborted = err && err.name === "AbortError";
        greenRegionEl.textContent = (aborted ? t("g.timeout") : t("g.offline")) + t("g.retry");
        greenSourceEl.textContent = "";
      });
  }

  function analyzeGreen() {
    if (lastSitePolygon) { analyzeGreenSite(lastSitePolygon); return; }
    var focus = lastFocus || map.getCenter();
    var lat = focus.lat, lng = focus.lng;
    greenRegionEl.textContent = t("g.queryRadius", { r: GREEN_RADIUS });
    greenIndEl.innerHTML = "";
    greenSourceEl.textContent = "";

    var le = '["leisure"~"^(park|garden|recreation_ground|nature_reserve|playground)$"]';
    var lu = '["landuse"~"^(grass|forest|meadow|greenfield|village_green)$"]';
    var around = "(around:" + GREEN_RADIUS + "," + lat + "," + lng + ")";
    var q = "[out:json][timeout:25];(" +
      "way" + le + around + ";" + "relation" + le + around + ";" +
      "way" + lu + around + ";" + "relation" + lu + around + ";" +
      ");out geom;";
    var url = OVERPASS + "?data=" + encodeURIComponent(q);

    fetchWithTimeout(url, 25000)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        var focusPt = turf.point([lng, lat]);
        var features = [];
        (data.elements || []).forEach(function (el) {
          elToPolygons(el).forEach(function (poly) {
            poly.properties.dist = nearestDist(focusPt, poly);
            features.push(poly);
          });
        });

        greenMarkers.clearLayers();
        // 服務圈
        L.circle([lat, lng], { radius: GREEN_RADIUS, color: "#3ba88f", weight: 1, fill: false, dashArray: "4" }).addTo(greenMarkers);

        if (features.length === 0) {
          greenRegionEl.textContent = t("g.noneRadius", { r: GREEN_RADIUS });
          greenIndEl.innerHTML = "";
          greenSourceEl.textContent = "";
          lastAnalysis = {
            focus: { lat: +lat.toFixed(5), lng: +lng.toFixed(5) },
            site_area_ha: lastSiteAreaHa,
            population: lastRegionProps,
            green: { radius_m: GREEN_RADIUS, parks_found: 0 }
          };
          renderHeat(0, lastRegionProps);
          return;
        }

        var sum = function (arr) { return arr.reduce(function (s, p) { return s + p.properties.area_m2; }, 0); };
        // 綠覆率以全部綠地計(代理樹冠覆蓋)
        var greenTotalM2 = sum(features);
        var coverage = (greenTotalM2 / (Math.PI * GREEN_RADIUS * GREEN_RADIUS)) * 100;

        // 公園類(leisure)且面積 ≥0.1ha 才算「有效公園」
        var parks = features.filter(function (f) {
          return f.properties.category === "park" && f.properties.area_m2 >= MIN_PARK_M2;
        });
        parks.sort(function (a, b) { return a.properties.dist - b.properties.dist; });
        var parks300 = parks.filter(function (p) { return p.properties.dist <= 300; });
        var parkArea500 = sum(parks);
        var nearestPark = parks[0] || null;
        var nearestHa = nearestPark ? nearestPark.properties.area_m2 / 10000 : null;
        var has300 = parks300.length > 0;

        // 零星綠地 = 非有效公園者(landuse 綠地 + 小於 0.1ha 的小塊)
        var incidental = features.filter(function (f) {
          return !(f.properties.category === "park" && f.properties.area_m2 >= MIN_PARK_M2);
        });
        var incidentalArea = sum(incidental);

        // 地圖:有效公園深綠、其餘綠地(零星/小塊)淺綠
        features.forEach(function (f) {
          var isEffPark = f.properties.category === "park" && f.properties.area_m2 >= MIN_PARK_M2;
          L.geoJSON(f, {
            style: isEffPark
              ? { color: "#1f6b46", weight: 1.5, fillColor: "#2e8b57", fillOpacity: 0.45 }
              : { color: "#7fae8e", weight: 0.5, fillColor: "#9cc8aa", fillOpacity: 0.25 }
          })
            .bindPopup(
              (isEffPark ? "🏞 " : "") + (f.properties.name || "") + "<br>" +
              (f.properties.area_m2 / 10000).toFixed(2) + t("u.ha") + " · " +
              Math.round(f.properties.dist) + " m")
            .addTo(greenMarkers);
        });

        greenRegionEl.innerHTML = t("g.radiusTitle", { r: GREEN_RADIUS });
        var ghdr = function (s) {
          return "<div class='ghdr' style='grid-column:1/-1'>" + s + "</div>";
        };
        var html = "";
        // ── 公園(≥0.1ha)──
        html += ghdr(t("g.hdrPark"));
        if (nearestPark) {
          html += ind(t("g.nearestDist"), Math.round(nearestPark.properties.dist), "m");
          html += ind(t("g.nearestArea"), nearestHa.toFixed(2), t("u.ha"));
        } else {
          html += "<div class='ind' style='grid-column:1/-1'><dt>" + t("g.noPark") + "</dt><dd>" + t("g.noPark500") + "</dd></div>";
        }
        html += ind(t("g.park300"), parks300.length, t("u.spot"));
        html += ind(t("g.park500"), parks.length, t("u.spot"));
        html += ind(t("g.parkArea500"), (parkArea500 / 10000).toFixed(2), t("u.ha"));
        // ── 零星綠地 ──
        html += ghdr(t("g.hdrIncid"));
        html += ind(t("g.count500"), incidental.length, t("u.spot"));
        html += ind(t("g.incidArea"), (incidentalArea / 10000).toFixed(2), t("u.ha"));
        // ── 整體 ──
        html += ghdr(t("g.hdrOverall"));
        html += ind(t("g.coverageAll"), coverage.toFixed(1), "%");
        html += ind(t("g.access330"), has300 ? t("g.met") : t("g.notMet"), "");
        var scale = nearestPark == null ? t("g.scaleNone")
          : nearestHa >= 4 ? t("g.scaleCommunity")
          : nearestHa >= 0.5 ? t("g.scaleNeighbor")
          : t("g.scaleChild");
        html += "<div class='ind' style='grid-column:1/-1'><dt>" + t("g.law") + "</dt><dd style='font-size:12px;font-weight:400'>" + scale + "</dd></div>";
        greenIndEl.innerHTML = html;

        // 彙整供 AI 解讀的真實數值,並產出熱環境研判
        lastAnalysis = {
          focus: { lat: +lat.toFixed(5), lng: +lng.toFixed(5) },
          site_area_ha: lastSiteAreaHa,
          population: lastRegionProps,
          green: {
            radius_m: GREEN_RADIUS,
            min_park_ha: MIN_PARK_M2 / 10000,
            nearest_park_dist_m: nearestPark ? Math.round(nearestPark.properties.dist) : null,
            nearest_park_area_ha: nearestHa != null ? +nearestHa.toFixed(2) : null,
            park_count_300m: parks300.length,
            park_count_500m: parks.length,
            park_area_500m_ha: +(parkArea500 / 10000).toFixed(2),
            incidental_count_500m: incidental.length,
            incidental_area_500m_ha: +(incidentalArea / 10000).toFixed(2),
            green_total_500m_ha: +(greenTotalM2 / 10000).toFixed(2),
            green_coverage_pct: +coverage.toFixed(1),
            has_300m_park_access: has300
          }
        };
        renderHeat(coverage, lastRegionProps);
        loadClimate(lat, lng);

        greenSourceEl.innerHTML = t("g.noteRadius");
      })
      .catch(function (err) {
        var aborted = err && err.name === "AbortError";
        greenRegionEl.textContent = (aborted ? t("g.timeout") : t("g.offline")) + t("g.retry");
        greenSourceEl.textContent = "";
      });
  }

  greenBtn.addEventListener("click", analyzeGreen);

  // =========================================================
  //  生態 / 生物多樣性(iNaturalist,瀏覽器即時查,有 CORS)
  // =========================================================
  var biodivBtn = document.getElementById("biodiv-btn");
  var biodivRegionEl = document.getElementById("biodiv-region");
  var biodivIndEl = document.getElementById("biodiv-indicators");
  var biodivSourceEl = document.getElementById("biodiv-source");
  var INAT = "https://api.inaturalist.org/v1";
  var BIODIV_RADIUS_KM = 1; // 物種查詢半徑(公里)
  var ICONIC = ["Plantae", "Aves", "Insecta", "Mammalia", "Amphibia", "Reptilia"];

  function resetBiodivPanel() {
    biodivRegionEl.textContent = t("biodiv.hint");
    biodivIndEl.innerHTML = "";
    biodivSourceEl.textContent = "";
  }

  function analyzeBiodiversity() {
    var focus = lastFocus || map.getCenter();
    var lat = focus.lat, lng = focus.lng;
    biodivRegionEl.textContent = t("b.querying", { r: BIODIV_RADIUS_KM });
    biodivIndEl.innerHTML = "";
    biodivSourceEl.textContent = "";

    var locale = window.i18nLang && window.i18nLang() === "en" ? "en" : "zh-TW";
    var geo = "lat=" + lat + "&lng=" + lng + "&radius=" + BIODIV_RADIUS_KM + "&verifiable=true&locale=" + locale;
    // 取實際物種清單(species_counts 預設按觀測次數遞減 → 即代表性物種)
    var spCountUrl = INAT + "/observations/species_counts?" + geo + "&per_page=20";
    var obsUrl = INAT + "/observations?" + geo + "&per_page=0";
    var threatUrl = INAT + "/observations/species_counts?" + geo + "&threatened=true&per_page=15";

    function taxonName(rec) {
      var tx = rec && rec.taxon;
      if (!tx) return "?";
      var common = tx.preferred_common_name;
      var sci = tx.name;
      if (common && sci) return common + "(" + sci + ")";
      return common || sci || "?";
    }

    Promise.all([
      fetchWithTimeout(spCountUrl, 20000).then(function (r) { return r.json(); }),
      fetchWithTimeout(obsUrl, 20000).then(function (r) { return r.json(); }),
      fetchWithTimeout(threatUrl, 20000).then(function (r) { return r.json(); })
    ]).then(function (res) {
      var spData = res[0] || {};
      var speciesCount = spData.total_results != null ? spData.total_results : 0;
      var obsCount = res[1] && res[1].total_results != null ? res[1].total_results : 0;
      var threatData = res[2] || {};
      var threatCount = threatData.total_results != null ? threatData.total_results : 0;

      if (obsCount === 0) {
        biodivRegionEl.textContent = t("b.none", { r: BIODIV_RADIUS_KM });
        biodivSourceEl.textContent = "";
        lastBiodiv = { radius_km: BIODIV_RADIUS_KM, species_count: 0, observation_count: 0 };
        return;
      }

      // 代表性物種(觀測最多者),跨分類群取前 10
      var topSpecies = (spData.results || []).slice(0, 10).map(function (rec) {
        return { name: taxonName(rec), count: rec.count || 0, group: (rec.taxon && rec.taxon.iconic_taxon_name) || "" };
      });
      // 受脅/保育物種名稱
      var threatened = (threatData.results || []).map(function (rec) { return taxonName(rec); });

      biodivRegionEl.innerHTML = t("b.title", { r: BIODIV_RADIUS_KM });
      var html = "";
      html += ind(t("b.species"), speciesCount, t("b.unitSp"));
      html += ind(t("b.obs"), obsCount, t("b.unitObs"));
      html += ind(t("b.threat"), threatCount, t("b.unitSp"));

      // 代表性物種清單(整列)
      html += "<div class='biolist' style='grid-column:1/-1'><dt>" + t("b.topSpecies") + "</dt><dd><ol>" +
        topSpecies.map(function (s) {
          return "<li>" + s.name + " <span class='u'>" + s.count + " " + t("b.unitObs") + "</span></li>";
        }).join("") + "</ol></dd></div>";

      // 受脅物種清單(若有)
      if (threatened.length) {
        html += "<div class='biolist warn' style='grid-column:1/-1'><dt>" + t("b.threatList") + "</dt><dd><ul>" +
          threatened.map(function (n) { return "<li>" + n + "</li>"; }).join("") + "</ul></dd></div>";
      }
      biodivIndEl.innerHTML = html;

      // 各分類群物種數(逐一查 species_counts,平行)
      Promise.all(ICONIC.map(function (key) {
        return fetchWithTimeout(INAT + "/observations/species_counts?" + geo + "&iconic_taxa=" + key + "&per_page=0", 20000)
          .then(function (r) { return r.json(); })
          .then(function (j) { return { key: key, n: (j && j.total_results) || 0 }; })
          .catch(function () { return { key: key, n: 0 }; });
      })).then(function (groups) {
        var taxa = {};
        var gh = "<div class='ghdr' style='grid-column:1/-1'>" + t("b.taxaHdr") + "</div>";
        groups.forEach(function (g) {
          taxa[t("tx." + g.key)] = g.n;
          gh += ind(t("tx." + g.key), g.n, t("b.unitSp"));
        });
        biodivIndEl.innerHTML += gh;
        if (lastBiodiv) lastBiodiv.taxa = taxa;
      });

      lastBiodiv = {
        radius_km: BIODIV_RADIUS_KM,
        species_count: speciesCount,
        observation_count: obsCount,
        threatened_species: threatCount,
        top_species: topSpecies.map(function (s) { return s.name + "(" + s.count + "筆)"; }),
        threatened_list: threatened
      };
      if (lastAnalysis) lastAnalysis.biodiversity = lastBiodiv;

      biodivSourceEl.innerHTML = t("b.note");
    }).catch(function (err) {
      var aborted = err && err.name === "AbortError";
      biodivRegionEl.textContent = (aborted ? t("b.timeout") : t("b.offline")) + t("g.retry");
      biodivSourceEl.textContent = "";
    });
  }

  biodivBtn.addEventListener("click", analyzeBiodiversity);

  // =========================================================
  //  第三階段 3c:AI 解讀(呼叫 /api/analyze,需 Cloudflare Pages 部署)
  // =========================================================
  var aiBtn = document.getElementById("ai-btn");
  var aiOutput = document.getElementById("ai-output");
  var aiSource = document.getElementById("ai-source");

  // 將報告(Markdown)轉為 HTML;有 marked 就用,否則退回純文字段落
  function renderReport(text) {
    if (window.marked && typeof window.marked.parse === "function") {
      try {
        return window.marked.parse(text);
      } catch (e) {
        /* 退回純文字 */
      }
    }
    var esc = text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc
      .split(/\n{2,}/)
      .map(function (p) { return "<p>" + p.replace(/\n/g, "<br>") + "</p>"; })
      .join("");
  }

  aiBtn.addEventListener("click", function () {
    // GitHub Pages 為純靜態、無後端,直接導向含後端的 Cloudflare 版本
    if (/github\.io$/i.test(location.hostname)) {
      aiOutput.innerHTML =
        "<p class='ai-err'>" + t("ai.ghPages") + "</p>" +
        "<p class='ai-err'>" + t("ai.useProd") +
        "<a href='https://map.healsdesign.org' target='_blank' rel='noopener'>map.healsdesign.org</a></p>";
      aiSource.textContent = t("ai.ghOther");
      return;
    }
    if (!lastAnalysis) {
      aiOutput.innerHTML = "";
      aiSource.textContent = t("ai.needData");
      return;
    }
    aiBtn.disabled = true;
    aiOutput.innerHTML = "<p class='ai-loading'>" + t("ai.loading") + "</p>";
    aiSource.textContent = "";

    // 串流讀取後端純文字回應(後端把 Claude 串流轉成 text/plain)
    fetch("./api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({}, lastAnalysis, { lang: (window.i18nLang ? window.i18nLang() : "zh") }))
    })
      .then(function (r) {
        var ct = r.headers.get("content-type") || "";
        // 後端錯誤時回 JSON;成功時回 text/plain 串流
        if (!r.ok || ct.indexOf("application/json") >= 0) {
          return r.text().then(function (txt) {
            var msg = txt;
            try { var j = JSON.parse(txt); if (j && j.error) msg = j.error; } catch (e) {}
            throw new Error(msg || ("HTTP " + r.status));
          });
        }
        if (!r.body || !r.body.getReader) {
          // 舊瀏覽器無串流:整段讀取
          return r.text().then(function (txt) {
            aiOutput.innerHTML = renderReport(txt || t("ai.empty"));
          });
        }
        var reader = r.body.getReader();
        var decoder = new TextDecoder();
        var acc = "";
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) { aiOutput.innerHTML = renderReport(acc || t("ai.empty")); return; }
            acc += decoder.decode(res.value, { stream: true });
            aiOutput.innerHTML = renderReport(acc);
            aiOutput.scrollTop = aiOutput.scrollHeight;
            return pump();
          });
        }
        return pump();
      })
      .then(function () {
        aiSource.textContent = t("ai.by");
      })
      .catch(function (err) {
        var msg = String(err && err.message ? err.message : err);
        aiOutput.innerHTML =
          "<p class='ai-err'>" + t("ai.fail") + "</p>" +
          "<p class='ai-err' style='opacity:.7'>" + t("ai.msg") + msg + "</p>";
        aiSource.textContent = "";
      })
      .finally(function () { aiBtn.disabled = false; });
  });

  // ---- 報告匯出 / 列印(另開乾淨獨立頁面,iPad 存 PDF 才穩定)----
  var exportBtn = document.getElementById("export-btn");

  function pnum(v, suffix) {
    return v === null || v === undefined ? "—" : v + (suffix || "");
  }
  function prow(label, val) {
    return "<tr><th>" + label + "</th><td>" + val + "</td></tr>";
  }

  var REPORT_CSS =
    "body{font-family:'Noto Sans TC','Segoe UI',system-ui,-apple-system,sans-serif;color:#111;margin:0;padding:24px;line-height:1.6;}" +
    ".doc{max-width:760px;margin:0 auto;}" +
    "h1{font-size:22px;margin:0 0 6px;}" +
    "h2{font-size:15px;margin:16px 0 6px;border-bottom:1px solid #888;padding-bottom:3px;}" +
    ".meta{color:#444;font-size:13px;margin:0 0 10px;}" +
    "table{width:100%;border-collapse:collapse;margin:6px 0 10px;}" +
    "th,td{border:1px solid #bbb;padding:4px 8px;text-align:left;font-size:13px;vertical-align:top;}" +
    "table.summary th{background:#f0f0f0;width:42%;font-weight:600;}" +
    ".src{font-size:11px;color:#555;}" +
    ".author{margin-top:14px;padding-top:8px;border-top:1px solid #ccc;font-size:12px;font-weight:600;color:#222;}" +
    ".bar{max-width:760px;margin:0 auto 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;}" +
    ".bar button{font-size:15px;padding:9px 18px;border:0;border-radius:8px;background:#3ba88f;color:#fff;cursor:pointer;}" +
    ".bar .hint{color:#777;font-size:12px;}" +
    "tr{page-break-inside:avoid;}h1,h2{page-break-after:avoid;}" +
    "@media print{.noprint{display:none!important;}body{padding:0;}}";

  function buildReportInner() {
    var p = lastAnalysis.population || {};
    var g = lastAnalysis.green || {};
    var h = lastAnalysis.heat || {};
    var focus = lastAnalysis.focus || {};
    var now = new Date();
    var aiHasReport = aiOutput.innerHTML.trim() &&
      !aiOutput.querySelector(".ai-err") && !aiOutput.querySelector(".ai-loading");
    var aiHtml = aiHasReport
      ? aiOutput.innerHTML.replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, "")
      : "<p style='color:#888'>" + t("r.aiEmpty") + "</p>";
    var MET = function (b) { return b === undefined ? "—" : (b ? t("r.met") : t("r.notMet")); };

    var html = "<h1>" + t("r.title") + "</h1>";
    html += "<p class='meta'>" + (lastRegionTitle || "") +
      "<br>" + t("r.coord") + pnum(focus.lat) + "°N, " + pnum(focus.lng) + "°E" +
      (lastSiteAreaHa != null ? t("r.siteArea") + lastSiteAreaHa + t("r.uHa") : "") +
      "<br>" + t("r.generated") + now.toLocaleString() + "</p>";

    html += "<h2>" + t("r.hPop") + "</h2><table class='summary'>" +
      prow(t("ind.pop"), pnum(p.pop, t("r.uPerson"))) + prow(t("ind.households"), pnum(p.households, t("r.uHh"))) +
      prow(t("ind.density"), pnum(p.density, t("r.uPkm2"))) + prow(t("ind.sex_ratio"), pnum(p.sex_ratio)) +
      prow(t("ind.aging_index"), pnum(p.aging_index)) + prow(t("ind.dep_ratio"), pnum(p.dep_ratio, " %")) +
      prow(t("h.elderly"), pnum(p.elderly_share, " %")) + prow(t("h.child"), pnum(p.child_share, " %")) +
      "</table>";

    if (g.mode === "within_site") {
      html += "<h2>" + t("r.hGreenSite") + "</h2><table class='summary'>" +
        prow(t("r.siteArea2"), pnum(g.site_area_ha, t("r.uHa"))) +
        prow(t("r.parkInSite"), pnum(g.park_count_in_site, t("r.uSpot"))) +
        prow(t("r.parkAreaInSite"), pnum(g.park_area_in_site_ha, t("r.uHa"))) +
        prow(t("r.incidInSite"), pnum(g.incidental_count_in_site, t("r.uSpot"))) +
        prow(t("r.greenInSite"), pnum(g.green_area_in_site_ha, t("r.uHa"))) +
        prow(t("r.siteCoverage"), pnum(g.site_green_coverage_pct, " %")) +
        prow(t("r.law45ref"), g.meets_10pct_ref === undefined ? "—" : (g.meets_10pct_ref ? t("r.met") : t("r.notMet2"))) +
        "</table>";
    } else {
      html += "<h2>" + t("r.hGreenRadius", { r: pnum(g.radius_m) }) + "</h2><table class='summary'>" +
        prow(t("r.nearestDist"), pnum(g.nearest_park_dist_m, " m")) + prow(t("r.nearestArea"), pnum(g.nearest_park_area_ha, t("r.uHa"))) +
        prow(t("r.p300"), pnum(g.park_count_300m, t("r.uSpot"))) + prow(t("r.p500"), pnum(g.park_count_500m, t("r.uSpot"))) +
        prow(t("r.pArea500"), pnum(g.park_area_500m_ha, t("r.uHa"))) +
        prow(t("r.incid500n"), pnum(g.incidental_count_500m, t("r.uSpot"))) +
        prow(t("r.incid500a"), pnum(g.incidental_area_500m_ha, t("r.uHa"))) +
        prow(t("r.covAll"), pnum(g.green_coverage_pct, " %")) +
        prow(t("r.access"), MET(g.has_300m_park_access)) +
        "</table>";
    }

    var cl = lastAnalysis.climate;
    if (cl) {
      html += "<h2>" + t("r.hClimate") + "</h2><table class='summary'>" +
        prow(t("r.clPeriod"), cl.reference_period || "—") +
        prow(t("r.clMean"), pnum(cl.annual_mean_temp_c, " °C")) +
        prow(t("r.clHottest"), cl.hottest_month
          ? t("cl.mon" + cl.hottest_month) + " " + pnum(cl.hottest_month_mean_c) + " °C" : "—") +
        prow(t("r.clHeatDays"), pnum(cl.heat_days_per_year_ge32c, " " + t("cl.daysYr"))) +
        prow(t("r.clPrecip"), pnum(cl.annual_precip_mm, " mm")) +
        prow(t("r.clWind"), cl.dominant_wind_dir || "—") +
        prow(t("r.clSolar"), pnum(cl.avg_daily_solar_mj_m2, " MJ/m²")) +
        "</table>";
    }

    html += "<h2>" + t("r.hHeat") + "</h2><table class='summary'>" +
      prow(t("r.covOSM"), pnum(h.green_coverage_pct, " %")) +
      prow(t("r.t30"), MET(h.meets_30pct_target)) +
      prow(t("r.vuln"), h.vulnerability_level || "—") +
      "</table>";

    var b = lastAnalysis.biodiversity;
    if (b) {
      html += "<h2>" + t("r.hBiodiv", { r: pnum(b.radius_km) }) + "</h2><table class='summary'>" +
        prow(t("r.species"), pnum(b.species_count, t("r.uSp"))) +
        prow(t("r.obs"), pnum(b.observation_count, t("r.uObs"))) +
        prow(t("r.threat"), pnum(b.threatened_species, t("r.uSp"))) +
        (b.top_species && b.top_species.length ? prow(t("r.topSp"), b.top_species.join("、")) : "") +
        (b.threatened_list && b.threatened_list.length ? prow(t("r.threatList"), b.threatened_list.join("、")) : "") +
        (b.taxa ? prow(t("r.taxa"),
          Object.keys(b.taxa).map(function (k) { return k + " " + b.taxa[k]; }).join("、")) : "") +
        "</table>";
    }

    html += "<h2>" + t("r.hAI") + "</h2><div>" + aiHtml + "</div>";

    html += "<h2>" + t("r.hSrc") + "</h2><p class='src'>" + t("r.src") + "</p>";
    html += "<p class='author'>" + t("foot.author") + "</p>";
    return html;
  }

  // 報告檔名:標題 + 地區 + 時戳。瀏覽器列印存 PDF 時以文件 <title> 為預設檔名,
  // 帶入地區與時間可避免每次都存成同名檔(使用者誤以為「沒更新、還是舊的」)。
  function reportFileTitle() {
    var d = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    // 地區名去除檔名不合法字元
    var region = (lastRegionTitle || "").replace(/[\\/:*?"<>|]/g, "").trim();
    return t("r.title") + (region ? "_" + region : "") + "_" + stamp;
  }

  function buildReportDoc() {
    var docLang = (window.i18nLang && window.i18nLang() === "en") ? "en" : "zh-Hant";
    return "<!doctype html><html lang='" + docLang + "'><head><meta charset='utf-8'>" +
      "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
      "<title>" + reportFileTitle() + "</title><style>" + REPORT_CSS + "</style></head><body>" +
      "<div class='bar noprint'><button onclick='window.print()'>🖨 " + t("ai.export") + "</button>" +
      "<span class='hint'>" + t("r.printHint") + "</span></div>" +
      "<div class='doc'>" + buildReportInner() + "</div></body></html>";
  }

  exportBtn.addEventListener("click", function () {
    if (!lastAnalysis) {
      aiSource.textContent = t("exp.needData");
      return;
    }
    var w = window.open("", "_blank");
    if (!w) {
      aiSource.textContent = t("exp.blocked");
      return;
    }
    w.document.open();
    w.document.write(buildReportDoc());
    w.document.close();
    aiSource.textContent = t("exp.opened");
  });

  // 語言切換時:重繪疊圖圖層名稱、空面板提示與已顯示的人口指標
  window.addEventListener("langchange", function () {
    // 疊圖圖層名稱
    document.querySelectorAll(".ov-label[data-ovkey]").forEach(function (el) {
      el.textContent = t(el.getAttribute("data-ovkey"));
    });
    // 空面板提示(分析結果為動態,提示使用者重新查詢以更新語言)
    if (!lastRegionProps) infoRegionEl.textContent = t("pop.tip");
    else if (lastRegionTitleHtml) renderIndicators(lastRegionProps, lastRegionTitleHtml);
  });

  // 在地圖右下角標示資料來源(Leaflet attribution 已含 NLSC)
  map.attributionControl.setPrefix(
    '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>'
  );
})();
