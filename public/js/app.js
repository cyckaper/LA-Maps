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
    if (w) w.textContent = "⚠ 無法載入(端點待確認)";
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
    row.innerHTML = "<input type='checkbox' data-ov='" + def.id + "'> " + def.label +
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
    toolHint.textContent = "標記模式啟用中:點地圖放置標記,再按一次按鈕結束。";
  }
  function disableMarkerMode() {
    markerMode = false;
    setMarkerBtnState(false);
    map.getContainer().style.cursor = "";
    toolHint.textContent = "提示:選「點選放標記」後,在地圖上點擊即可放置標記。";
  }

  toolMarkerBtn.addEventListener("click", enableMarkerMode);

  map.on("click", function (e) {
    if (!markerMode) return;
    var m = L.marker(e.latlng).addTo(markersGroup);
    m.bindPopup(
      "標記<br>緯度 " +
        e.latlng.lat.toFixed(5) +
        "<br>經度 " +
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
      toolHint.textContent = "已取消繪製。";
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
    toolHint.textContent = "逐點點擊描繪基地範圍,雙擊或點回起點以完成。";
  });

  map.on(L.Draw.Event.CREATED, function (e) {
    drawnItems.addLayer(e.layer);
    polygonDrawer = null;
    setPolygonBtnState(false);
    computeArea();
    toolHint.textContent = "基地範圍已完成,面積與所在鄉鎮指標顯示於左側。";
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
    areaValueEl.textContent = ha.toLocaleString("zh-Hant", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    areaDetailEl.textContent =
      "約 " +
      Math.round(totalSqm).toLocaleString("zh-Hant") +
      " 平方公尺 · " +
      count +
      " 個範圍";
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
    resetGreenPanel();
    toolHint.textContent = "已清除所有標記與範圍。";
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
      setStatus("請先輸入地名。", "error");
      return;
    }
    setStatus("搜尋中…", null);

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
          setStatus("找不到「" + q + "」,請換個關鍵字試試。", "error");
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
        setStatus("已定位:" + (hit.display_name || q), "ok");
      })
      .catch(function (err) {
        // 連線失敗 / 逾時 / 被阻擋 的退回處理
        var aborted = err && err.name === "AbortError";
        setStatus(
          (aborted ? "搜尋逾時" : "搜尋服務暫時無法連線") +
            "。可改用滑鼠拖曳地圖,或稍後再試。",
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
    { key: "pop", label: "人口數", unit: "人", int: true },
    { key: "households", label: "戶數", unit: "戶", int: true },
    { key: "density", label: "人口密度", unit: "人/km²" },
    { key: "household_size", label: "戶量", unit: "人/戶" },
    { key: "sex_ratio", label: "性比例", unit: "男/百女" },
    { key: "aging_index", label: "老化指數", unit: "" },
    { key: "dep_ratio", label: "扶養比", unit: "%" },
    { key: "child_dep", label: "扶幼比", unit: "%" },
    { key: "old_dep", label: "扶老比", unit: "%" },
    { key: "area_km2", label: "面積", unit: "km²" }
  ];

  function fmtVal(v, def) {
    if (v == null || v === "") return "—";
    if (def.int) return Math.round(v).toLocaleString("zh-Hant");
    return Number(v).toLocaleString("zh-Hant", { maximumFractionDigits: 2 });
  }

  function resetInfoPanel() {
    infoRegionEl.textContent = "點一個點查村里、畫一塊面查鄉鎮。";
    indicatorsEl.innerHTML = "";
    infoSourceEl.textContent = "";
  }

  function renderIndicators(props, titleHtml) {
    lastRegionProps = props;
    lastRegionTitle = titleHtml.replace(/<[^>]+>/g, "").trim();
    infoRegionEl.innerHTML = titleHtml;
    var html = "";
    for (var i = 0; i < INDICATOR_DEFS.length; i++) {
      var d = INDICATOR_DEFS[i];
      var val = props ? props[d.key] : null;
      html +=
        "<div class='ind'><dt>" + d.label + "</dt><dd>" +
        fmtVal(val, d) +
        (d.unit ? " <span class='u'>" + d.unit + "</span>" : "") +
        "</dd></div>";
    }
    indicatorsEl.innerHTML = html;
    var period = DATA.meta && DATA.meta.population_period;
    if (props && props.pop != null) {
      infoSourceEl.textContent =
        "人口資料期別(民國):" + (period || "—") + " · 內政部戶政司";
    } else {
      infoSourceEl.textContent = "(此區暫無人口數值,僅顯示界線與面積)";
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
        "尚無圖資(資料建置中或建置失敗,請稍後重新整理)。";
    }
  });

  function ensureVillages() {
    if (DATA.villagesIdx) return Promise.resolve(true);
    if (DATA.villagesLoading) return DATA.villagesLoading;
    infoRegionEl.textContent = "載入村里資料中…";
    DATA.villagesLoading = loadJSON("./data/villages.json")
      .then(function (fc) {
        DATA.villages = fc;
        DATA.villagesIdx = buildIndex(fc);
        return true;
      })
      .catch(function () {
        infoRegionEl.textContent = "村里資料載入失敗。";
        return false;
      });
    return DATA.villagesLoading;
  }

  function lookupVillage(lat, lng) {
    ensureVillages().then(function (ok) {
      if (!ok || !DATA.villagesIdx) return;
      var f = locate(lng, lat, DATA.villagesIdx);
      if (!f) {
        infoRegionEl.textContent = "此點不在任何村里範圍內。";
        indicatorsEl.innerHTML = "";
        return;
      }
      var p = f.properties;
      renderIndicators(
        p,
        "村里 · " + (p.COUNTYNAME || "") + (p.TOWNNAME || "") +
          " <b>" + (p.VILLNAME || "") + "</b>"
      );
    });
  }

  function lookupTown(lat, lng) {
    if (!DATA.townsIdx) {
      infoRegionEl.textContent = "鄉鎮圖資尚未就緒。";
      return;
    }
    var f = locate(lng, lat, DATA.townsIdx);
    if (!f) {
      infoRegionEl.textContent = "範圍中心不在任何鄉鎮市區內。";
      indicatorsEl.innerHTML = "";
      return;
    }
    var p = f.properties;
    renderIndicators(
      p,
      "鄉鎮市區 · " + (p.COUNTYNAME || "") + " <b>" + (p.TOWNNAME || "") + "</b>"
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

  var OVERPASS = "https://overpass-api.de/api/interpreter";
  var GREEN_RADIUS = 500; // 公尺:服務圈半徑
  var MIN_PARK_M2 = 1000; // 有效公園最小面積(0.1 公頃,兒童遊樂場法定最小規模)
  var greenMarkers = L.layerGroup().addTo(map);

  function resetGreenPanel() {
    greenRegionEl.textContent = "先放標記或畫基地,再按「分析周邊綠地」。";
    greenIndEl.innerHTML = "";
    greenSourceEl.textContent = "";
    greenMarkers.clearLayers();
    heatRegionEl.textContent = "按上方「分析周邊綠地」後,這裡顯示熱環境與脆弱族群研判。";
    heatIndEl.innerHTML = "";
    heatSourceEl.textContent = "";
  }

  // 熱環境/健康研判:綠覆率(對 3-30-300 的 30% 目標)× 脆弱族群(高齡+幼年)
  function renderHeat(greenCoveragePct, props) {
    var elderly = props && props.elderly_share != null ? props.elderly_share : null;
    var child = props && props.child_share != null ? props.child_share : null;
    var greenDeficit = Math.max(0, Math.min(1, (30 - greenCoveragePct) / 30)); // 0..1
    var vulnShare = elderly != null && child != null ? (elderly + child) / 100 : null;
    var vulnNorm = vulnShare != null ? Math.min(1, vulnShare / 0.4) : null; // 40% 視為高
    var heat = vulnNorm != null ? 0.5 * greenDeficit + 0.5 * vulnNorm : greenDeficit;
    var level = heat > 0.66 ? "高" : heat > 0.34 ? "中" : "低";
    var color = heat > 0.66 ? "#d56456" : heat > 0.34 ? "#d8a657" : "#45c2a4";

    heatRegionEl.innerHTML =
      "高溫脆弱度研判:<b style='color:" + color + "'>" + level + "</b>";
    var html = "";
    html += ind("綠覆率(OSM下限)", greenCoveragePct.toFixed(1), "%");
    html += ind("對 30% 目標", (greenCoveragePct >= 30 ? "✓ 達標" : "✗ 不足"), "");
    html += ind("高齡比例(65+)", elderly != null ? elderly.toFixed(1) : "—", "%");
    html += ind("幼年比例(0-14)", child != null ? child.toFixed(1) : "—", "%");
    heatIndEl.innerHTML = html;

    heatSourceEl.innerHTML =
      "研判方法:綠覆率(OSM 綠地/服務圈面積,屬下限估計)對照 3-30-300 的 30% 樹冠目標," +
      "結合高齡與幼年(高溫敏感族群)比例綜合研判。<br>" +
      "※ 此為依代理指標與實證關聯之<b>研判</b>,非實測健康/氣溫數據。";

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

  // way 的 geometry(來自 out geom)轉成 turf polygon
  function wayToPolygon(el) {
    if (!el.geometry || el.geometry.length < 4) return null;
    var ring = el.geometry.map(function (p) { return [p.lon, p.lat]; });
    var first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    if (ring.length < 4) return null;
    try {
      var poly = turf.polygon([ring]);
      var tags = el.tags || {};
      // leisure 類視為「公園/正式開放空間」;landuse 類視為「零星綠覆」
      poly.properties = {
        name: tags.name || tags["name:zh"] || (tags.leisure ? "(未命名公園)" : "(零星綠地)"),
        category: tags.leisure ? "park" : "green"
      };
      return poly;
    } catch (e) {
      return null;
    }
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
    greenRegionEl.textContent = "查詢基地範圍內 OSM 綠地中…";
    greenIndEl.innerHTML = "";
    greenSourceEl.textContent = "";

    var le = '["leisure"~"^(park|garden|recreation_ground|nature_reserve|playground)$"]';
    var lu = '["landuse"~"^(grass|forest|meadow|greenfield|village_green)$"]';
    var bbox = "(" + bb[1] + "," + bb[0] + "," + bb[3] + "," + bb[2] + ")";
    var q = "[out:json][timeout:25];(" +
      "way" + le + bbox + ";" + "way" + lu + bbox + ";" + ");out geom;";
    var url = OVERPASS + "?data=" + encodeURIComponent(q);

    fetchWithTimeout(url, 25000)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        var parks = [], incid = [], parkM2 = 0, incidM2 = 0, greenM2 = 0;
        (data.elements || []).forEach(function (el) {
          if (el.type !== "way") return;
          var poly = wayToPolygon(el);
          if (!poly) return;
          var clip = null;
          try { clip = turf.intersect(poly, sitePoly); } catch (e) { clip = null; }
          if (!clip) return; // 不在基地內
          var a = 0;
          try { a = turf.area(clip); } catch (e) { a = 0; }
          if (a <= 0) return;
          poly.properties.clip_area_m2 = a;
          greenM2 += a;
          if (poly.properties.category === "park" && poly.properties.area_m2 >= MIN_PARK_M2) {
            parks.push(poly); parkM2 += a;
          } else {
            incid.push(poly); incidM2 += a;
          }
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
            (isPark ? "🏞 公園:" : "綠地:") + (f.properties.name || "") + "<br>基地內 " +
            (f.properties.clip_area_m2 / 10000).toFixed(2) + " 公頃").addTo(greenMarkers);
        });

        var siteHa = siteAreaM2 / 10000;
        var coverage = siteAreaM2 > 0 ? (greenM2 / siteAreaM2) * 100 : 0;
        var meets10 = coverage >= 10;

        greenRegionEl.innerHTML = "基地範圍內綠地分析(面積 <b>" + siteHa.toFixed(2) + "</b> 公頃)";
        var ghdr = function (t) { return "<div class='ghdr' style='grid-column:1/-1'>" + t + "</div>"; };
        var html = "";
        html += ghdr("基地內公園(≥0.1ha)");
        html += ind("處數", parks.length, "處");
        html += ind("面積", (parkM2 / 10000).toFixed(2), "公頃");
        html += ghdr("基地內零星綠地");
        html += ind("處數", incid.length, "處");
        html += ind("面積", (incidM2 / 10000).toFixed(2), "公頃");
        html += ghdr("整體");
        html += ind("基地內綠地總面積", (greenM2 / 10000).toFixed(2), "公頃");
        html += ind("基地綠覆率", coverage.toFixed(1), "%");
        html += "<div class='ind' style='grid-column:1/-1'><dt>都市計畫法§45 對照</dt><dd style='font-size:12px;font-weight:400'>" +
          "基地綠覆率 " + coverage.toFixed(1) + "% " + (meets10 ? "✓ 達 10% 參考門檻" : "✗ 未達 10%(註:§45 針對計畫區整體)") +
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

        greenSourceEl.innerHTML =
          "資料:OpenStreetMap(即時查詢,可能不完整)。綠地面積取與基地範圍相交部分。<br>" +
          "對照:都市計畫法§45(公園綠地廣場兒童遊樂場合計≥計畫面積10%);綠覆率屬 OSM 下限估計。";
      })
      .catch(function (err) {
        var aborted = err && err.name === "AbortError";
        greenRegionEl.textContent =
          (aborted ? "OSM 查詢逾時" : "OSM 綠地服務暫時無法連線") + ",請稍後再試。";
        greenSourceEl.textContent = "";
      });
  }

  function analyzeGreen() {
    if (lastSitePolygon) { analyzeGreenSite(lastSitePolygon); return; }
    var focus = lastFocus || map.getCenter();
    var lat = focus.lat, lng = focus.lng;
    greenRegionEl.textContent = "查詢 OSM 綠地中…(半徑 " + GREEN_RADIUS + "m)";
    greenIndEl.innerHTML = "";
    greenSourceEl.textContent = "";

    var le = '["leisure"~"^(park|garden|recreation_ground|nature_reserve|playground)$"]';
    var lu = '["landuse"~"^(grass|forest|meadow|greenfield|village_green)$"]';
    var around = "(around:" + GREEN_RADIUS + "," + lat + "," + lng + ")";
    var q = "[out:json][timeout:25];(" +
      "way" + le + around + ";" +
      "way" + lu + around + ";" +
      ");out geom;";
    var url = OVERPASS + "?data=" + encodeURIComponent(q);

    fetchWithTimeout(url, 25000)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        var focusPt = turf.point([lng, lat]);
        var features = [];
        (data.elements || []).forEach(function (el) {
          if (el.type !== "way") return;
          var poly = wayToPolygon(el);
          if (!poly) return;
          poly.properties.area_m2 = turf.area(poly);
          poly.properties.dist = nearestDist(focusPt, poly);
          features.push(poly);
        });

        greenMarkers.clearLayers();
        // 服務圈
        L.circle([lat, lng], { radius: GREEN_RADIUS, color: "#3ba88f", weight: 1, fill: false, dashArray: "4" }).addTo(greenMarkers);

        if (features.length === 0) {
          greenRegionEl.textContent = "周邊 " + GREEN_RADIUS + "m 內查無 OSM 綠地圖徵(或該區 OSM 標記不全)。";
          greenIndEl.innerHTML = "";
          greenSourceEl.textContent = "資料:OpenStreetMap(可能不完整)";
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
              (isEffPark ? "🏞 公園:" : "綠地:") + (f.properties.name || "") + "<br>" +
              (f.properties.area_m2 / 10000).toFixed(2) + " 公頃 · 距離 " +
              Math.round(f.properties.dist) + " m")
            .addTo(greenMarkers);
        });

        greenRegionEl.innerHTML = "焦點周邊 <b>" + GREEN_RADIUS + " m</b> 綠地分析";
        var ghdr = function (t) {
          return "<div class='ghdr' style='grid-column:1/-1'>" + t + "</div>";
        };
        var html = "";
        // ── 公園(≥0.1ha)──
        html += ghdr("公園(≥0.1ha)");
        if (nearestPark) {
          html += ind("最近公園距離", Math.round(nearestPark.properties.dist), "m");
          html += ind("最近公園面積", nearestHa.toFixed(2), "公頃");
        } else {
          html += "<div class='ind' style='grid-column:1/-1'><dt>最近公園</dt><dd>500m 內無 ≥0.1ha 公園</dd></div>";
        }
        html += ind("300m 內公園", parks300.length, "處");
        html += ind("500m 內公園", parks.length, "處");
        html += ind("公園面積(500m)", (parkArea500 / 10000).toFixed(2), "公頃");
        // ── 零星綠地 ──
        html += ghdr("零星綠地(草地 · 小塊)");
        html += ind("500m 內處數", incidental.length, "處");
        html += ind("零星綠地面積", (incidentalArea / 10000).toFixed(2), "公頃");
        // ── 整體 ──
        html += ghdr("整體");
        html += ind("綠覆率(全綠地)", coverage.toFixed(1), "%");
        html += ind("3-30-300 可及性", has300 ? "✓ 達標" : "✗ 不足", "");
        var scale = nearestPark == null ? "周邊 500m 內無 ≥0.1ha 公園"
          : nearestHa >= 4 ? "最近公園達社區公園規模(≥4ha)"
          : nearestHa >= 0.5 ? "最近公園達閭鄰公園規模(≥0.5ha)"
          : "最近公園達兒童遊樂場規模(≥0.1ha)";
        html += "<div class='ind' style='grid-column:1/-1'><dt>法規對照</dt><dd style='font-size:12px;font-weight:400'>" + scale + "</dd></div>";
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

        greenSourceEl.innerHTML =
          "資料:OpenStreetMap(即時查詢,可能不完整)。公園=OSM leisure 類且 ≥0.1ha;綠覆率含全部綠地(含零星草地,代理樹冠)。<br>" +
          "準則:3-30-300(住家 300m 內應有公園/綠地)、通盤檢討辦法(兒童遊樂場≥0.1ha、閭鄰公園≥0.5ha、社區公園≥4ha);都市計畫法§45 公園綠地廣場兒童遊樂場合計≥計畫面積10%。";
      })
      .catch(function (err) {
        var aborted = err && err.name === "AbortError";
        greenRegionEl.textContent =
          (aborted ? "OSM 查詢逾時" : "OSM 綠地服務暫時無法連線") + ",請稍後再試。";
        greenSourceEl.textContent = "";
      });
  }

  greenBtn.addEventListener("click", analyzeGreen);

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
        "<p class='ai-err'>此頁為 GitHub Pages 靜態預覽,沒有後端,無法執行 AI 解讀。</p>" +
        "<p class='ai-err'>請改用含後端的正式版本:" +
        "<a href='https://map.healsdesign.org' target='_blank' rel='noopener'>map.healsdesign.org</a></p>";
      aiSource.textContent = "(其他分析功能在本頁皆可正常使用)";
      return;
    }
    if (!lastAnalysis) {
      aiOutput.innerHTML = "";
      aiSource.textContent = "請先放標記/畫基地並按「分析周邊綠地」,產生數據後再生成報告。";
      return;
    }
    aiBtn.disabled = true;
    aiOutput.innerHTML = "<p class='ai-loading'>AI 解讀中…(約 10-20 秒)</p>";
    aiSource.textContent = "";

    fetchWithTimeout("./api/analyze", 45000, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lastAnalysis)
    })
      .then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
      })
      .then(function (res) {
        if (!res.ok) {
          throw new Error((res.j && res.j.error) || ("HTTP " + res.status));
        }
        aiOutput.innerHTML = renderReport(res.j.report || "(無內容)");
        aiSource.textContent = "由 Claude 依本基地真實數值生成 · 模型 " + (res.j.model || "");
      })
      .catch(function (err) {
        var msg = String(err && err.message ? err.message : err);
        // GitHub Pages 上沒有後端函式,/api/analyze 會 404 → 友善提示
        aiOutput.innerHTML =
          "<p class='ai-err'>AI 解讀暫時無法使用。</p>" +
          "<p class='ai-err'>請確認後端 <code>/api/analyze</code> 已部署,且已於主機後台設定 " +
          "<code>ANTHROPIC_API_KEY</code> 環境變數並重新部署。</p>" +
          "<p class='ai-err' style='opacity:.7'>訊息:" + msg + "</p>";
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
      : "<p style='color:#888'>(尚未產生 AI 報告)</p>";

    var html = "<h1>基地分析報告</h1>";
    html += "<p class='meta'>" + (lastRegionTitle || "") +
      "<br>座標:" + pnum(focus.lat) + "°N, " + pnum(focus.lng) + "°E" +
      (lastSiteAreaHa != null ? " · 基地面積 " + lastSiteAreaHa + " 公頃" : "") +
      "<br>產製時間:" + now.toLocaleString("zh-TW") + "</p>";

    html += "<h2>人口與指標</h2><table class='summary'>" +
      prow("總人口", pnum(p.pop, " 人")) + prow("戶數", pnum(p.households, " 戶")) +
      prow("人口密度", pnum(p.density, " 人/km²")) + prow("性別比", pnum(p.sex_ratio)) +
      prow("老化指數", pnum(p.aging_index)) + prow("扶養比", pnum(p.dep_ratio, " %")) +
      prow("高齡比例(65+)", pnum(p.elderly_share, " %")) + prow("幼年比例(0-14)", pnum(p.child_share, " %")) +
      "</table>";

    if (g.mode === "within_site") {
      html += "<h2>開放空間 · 綠地(基地範圍內)</h2><table class='summary'>" +
        prow("基地面積", pnum(g.site_area_ha, " 公頃")) +
        prow("基地內公園(≥0.1ha)", pnum(g.park_count_in_site, " 處")) +
        prow("基地內公園面積", pnum(g.park_area_in_site_ha, " 公頃")) +
        prow("基地內零星綠地", pnum(g.incidental_count_in_site, " 處")) +
        prow("基地內綠地總面積", pnum(g.green_area_in_site_ha, " 公頃")) +
        prow("基地綠覆率", pnum(g.site_green_coverage_pct, " %")) +
        prow("§45 10% 對照", g.meets_10pct_ref === undefined ? "—" : (g.meets_10pct_ref ? "達標" : "未達")) +
        "</table>";
    } else {
      html += "<h2>開放空間 · 綠地(半徑 " + pnum(g.radius_m, " m") + ",公園≥0.1ha)</h2><table class='summary'>" +
        prow("最近公園距離", pnum(g.nearest_park_dist_m, " m")) + prow("最近公園面積", pnum(g.nearest_park_area_ha, " 公頃")) +
        prow("300m 內公園", pnum(g.park_count_300m, " 處")) + prow("500m 內公園", pnum(g.park_count_500m, " 處")) +
        prow("公園面積(500m)", pnum(g.park_area_500m_ha, " 公頃")) +
        prow("零星綠地處數(500m)", pnum(g.incidental_count_500m, " 處")) +
        prow("零星綠地面積(500m)", pnum(g.incidental_area_500m_ha, " 公頃")) +
        prow("綠覆率(全綠地)", pnum(g.green_coverage_pct, " %")) +
        prow("3-30-300 可及性", g.has_300m_park_access === undefined ? "—" : (g.has_300m_park_access ? "達標" : "不足")) +
        "</table>";
    }

    html += "<h2>熱環境 · 健康研判</h2><table class='summary'>" +
      prow("綠覆率(OSM下限)", pnum(h.green_coverage_pct, " %")) +
      prow("對 30% 目標", h.meets_30pct_target === undefined ? "—" : (h.meets_30pct_target ? "達標" : "不足")) +
      prow("高溫脆弱度", h.vulnerability_level || "—") +
      "</table>";

    html += "<h2>AI 綜合解讀</h2><div>" + aiHtml + "</div>";

    html += "<h2>資料來源與免責</h2><p class='src'>" +
      "底圖:NLSC;界線:NLSC / taiwan-atlas;人口:內政部戶政司 ODRP014(11412);" +
      "綠地:© OpenStreetMap 貢獻者(ODbL)/ Overpass;地名:OSM Nominatim;AI:Anthropic Claude。<br>" +
      "免責:綠地與綠覆率為即時查詢之下限估計;熱環境/健康為研判而非實測。本報告僅供規劃參考,不構成正式法定文件。</p>";
    return html;
  }

  function buildReportDoc() {
    return "<!doctype html><html lang='zh-Hant'><head><meta charset='utf-8'>" +
      "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
      "<title>基地分析報告</title><style>" + REPORT_CSS + "</style></head><body>" +
      "<div class='bar noprint'><button onclick='window.print()'>🖨 列印 / 存 PDF</button>" +
      "<span class='hint'>在列印對話框可選「儲存成 PDF」</span></div>" +
      "<div class='doc'>" + buildReportInner() + "</div></body></html>";
  }

  exportBtn.addEventListener("click", function () {
    if (!lastAnalysis) {
      aiSource.textContent = "請先放標記/畫基地並按「分析周邊綠地」,有數據後再匯出報告。";
      return;
    }
    var w = window.open("", "_blank");
    if (!w) {
      aiSource.textContent = "瀏覽器阻擋了新分頁,請允許彈出視窗後再按一次「匯出」。";
      return;
    }
    w.document.open();
    w.document.write(buildReportDoc());
    w.document.close();
    aiSource.textContent = "已在新分頁開啟報告,於該頁按「列印 / 存 PDF」即可儲存。";
  });

  // 在地圖右下角標示資料來源(Leaflet attribution 已含 NLSC)
  map.attributionControl.setPrefix(
    '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>'
  );
})();
