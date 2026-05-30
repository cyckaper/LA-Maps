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

  // 疊圖:LUIMAP(國土利用調查)
  var luimapLayer = nlscLayer("LUIMAP", { opacity: 0.55 });
  var luimapVisible = false;

  // ---- 圖層群組 ----
  var markersGroup = L.layerGroup().addTo(map);
  var drawnItems = new L.FeatureGroup().addTo(map);

  // 最近一次分析焦點(放標記或畫基地時更新),供綠地分析使用
  var lastFocus = null;
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
    if (luimapVisible) luimapLayer.bringToFront();
    currentBase = next;
  });

  // =========================================================
  //  LUIMAP 疊圖 + 透明度
  // =========================================================
  var luimapToggle = document.getElementById("luimap-toggle");
  var luimapOpacity = document.getElementById("luimap-opacity");
  var luimapOpacityVal = document.getElementById("luimap-opacity-val");

  luimapToggle.addEventListener("change", function () {
    if (luimapToggle.checked) {
      luimapLayer.addTo(map);
      luimapLayer.bringToFront();
      luimapVisible = true;
    } else {
      map.removeLayer(luimapLayer);
      luimapVisible = false;
    }
  });

  luimapOpacity.addEventListener("input", function () {
    var v = parseFloat(luimapOpacity.value);
    luimapLayer.setOpacity(v);
    luimapOpacityVal.textContent = v.toFixed(2);
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
      poly.properties = { name: (el.tags && (el.tags.name || el.tags["name:zh"])) || "(未命名綠地)" };
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

  function analyzeGreen() {
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
        var parks = [];
        (data.elements || []).forEach(function (el) {
          if (el.type !== "way") return;
          var poly = wayToPolygon(el);
          if (!poly) return;
          poly.properties.area_m2 = turf.area(poly);
          poly.properties.dist = nearestDist(focusPt, poly);
          parks.push(poly);
        });

        greenMarkers.clearLayers();
        // 服務圈
        L.circle([lat, lng], { radius: GREEN_RADIUS, color: "#3ba88f", weight: 1, fill: false, dashArray: "4" }).addTo(greenMarkers);

        if (parks.length === 0) {
          greenRegionEl.textContent = "周邊 " + GREEN_RADIUS + "m 內查無 OSM 綠地圖徵(或該區 OSM 標記不全)。";
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

        parks.sort(function (a, b) { return a.properties.dist - b.properties.dist; });
        var nearest = parks[0];
        var within300 = parks.filter(function (p) { return p.properties.dist <= 300; });
        var sum = function (arr) { return arr.reduce(function (s, p) { return s + p.properties.area_m2; }, 0); };
        var area300 = sum(within300);
        var area500 = sum(parks);
        var has300 = within300.length > 0;
        var nearestHa = nearest.properties.area_m2 / 10000;
        var coverage = (area500 / (Math.PI * GREEN_RADIUS * GREEN_RADIUS)) * 100;

        // 在地圖上畫出綠地
        parks.forEach(function (p) {
          L.geoJSON(p, { style: { color: "#2e8b57", weight: 1, fillColor: "#3ba88f", fillOpacity: 0.35 } })
            .bindPopup((p.properties.name || "綠地") + "<br>" +
              (p.properties.area_m2 / 10000).toFixed(2) + " 公頃 · 距離 " +
              Math.round(p.properties.dist) + " m")
            .addTo(greenMarkers);
        });

        greenRegionEl.innerHTML = "焦點周邊 <b>" + GREEN_RADIUS + " m</b> 綠地分析";
        var html = "";
        html += ind("最近綠地距離", Math.round(nearest.properties.dist), "m");
        html += ind("最近綠地面積", nearestHa.toFixed(2), "公頃");
        html += ind("300m 內綠地", within300.length, "處");
        html += ind("300m 內面積", (area300 / 10000).toFixed(2), "公頃");
        html += ind("500m 內綠地", parks.length, "處");
        html += ind("500m 內面積", (area500 / 10000).toFixed(2), "公頃");
        html += ind("3-30-300 可及性", has300 ? "✓ 達標" : "✗ 不足", "");
        // 法規對照:最近公園規模屬性
        var scale = nearestHa >= 4 ? "達社區公園規模(≥4ha)"
          : nearestHa >= 0.5 ? "達閭鄰公園規模(≥0.5ha)"
          : nearestHa >= 0.1 ? "達兒童遊樂場規模(≥0.1ha)"
          : "小於兒童遊樂場最小規模(<0.1ha)";
        html += "<div class='ind' style='grid-column:1/-1'><dt>法規對照(最近綠地)</dt><dd style='font-size:12px;font-weight:400'>" + scale + "</dd></div>";
        greenIndEl.innerHTML = html;

        // 彙整供 AI 解讀的真實數值,並產出熱環境研判
        lastAnalysis = {
          focus: { lat: +lat.toFixed(5), lng: +lng.toFixed(5) },
          site_area_ha: lastSiteAreaHa,
          population: lastRegionProps,
          green: {
            radius_m: GREEN_RADIUS,
            nearest_dist_m: Math.round(nearest.properties.dist),
            nearest_area_ha: +nearestHa.toFixed(2),
            count_300m: within300.length,
            area_300m_ha: +(area300 / 10000).toFixed(2),
            count_500m: parks.length,
            area_500m_ha: +(area500 / 10000).toFixed(2),
            has_300m_access: has300
          }
        };
        renderHeat(coverage, lastRegionProps);

        greenSourceEl.innerHTML =
          "資料:OpenStreetMap(即時查詢,可能不完整)<br>" +
          "準則:3-30-300(住家 300m 內應有綠地)、都市計畫定期通盤檢討辦法(兒童遊樂場≥0.1ha、閭鄰公園≥0.5ha、社區公園≥4ha);都市計畫法§45 公園綠地廣場兒童遊樂場合計≥計畫面積10%。";
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
        "<p class='ai-err'>請改用含後端的版本:" +
        "<a href='https://la-maps.pages.dev' target='_blank' rel='noopener'>la-maps.pages.dev</a></p>";
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
          "<p class='ai-err'>AI 解讀目前無法使用。</p>" +
          "<p class='ai-err'>此功能需部署於 <b>Cloudflare Pages</b> 並設定 <code>ANTHROPIC_API_KEY</code> 後才會運作" +
          "(GitHub Pages 為純靜態,無後端)。</p>" +
          "<p class='ai-err' style='opacity:.7'>訊息:" + msg + "</p>";
        aiSource.textContent = "";
      })
      .finally(function () { aiBtn.disabled = false; });
  });

  // ---- 報告匯出 / 列印(可存 PDF)----
  var exportBtn = document.getElementById("export-btn");
  var printArea = document.getElementById("print-area");

  function pnum(v, suffix) {
    return v === null || v === undefined ? "—" : v + (suffix || "");
  }
  function prow(label, val) {
    return "<tr><th>" + label + "</th><td>" + val + "</td></tr>";
  }

  function buildPrintArea() {
    if (!lastAnalysis) return false;
    var p = lastAnalysis.population || {};
    var g = lastAnalysis.green || {};
    var h = lastAnalysis.heat || {};
    var focus = lastAnalysis.focus || {};
    var now = new Date();
    var aiHasReport = aiOutput.innerHTML.trim() &&
      !aiOutput.querySelector(".ai-err") && !aiOutput.querySelector(".ai-loading");
    // 去掉 AI 報告開頭重複的大標題(避免整份出現兩個「基地分析報告」)
    var aiHtml = aiHasReport
      ? aiOutput.innerHTML.replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, "")
      : "<p class='pr-muted'>(尚未產生 AI 報告)</p>";

    var html = "<div class='pr-doc'>";
    html += "<h1>基地分析報告</h1>";
    html += "<p class='pr-meta'>" + (lastRegionTitle || "") +
      "<br>座標:" + pnum(focus.lat) + "°N, " + pnum(focus.lng) + "°E" +
      (lastSiteAreaHa != null ? " · 基地面積 " + lastSiteAreaHa + " 公頃" : "") +
      "<br>產製時間:" + now.toLocaleString("zh-TW") + "</p>";

    html += "<h2>人口與指標</h2><table>" +
      prow("總人口", pnum(p.pop, " 人")) + prow("戶數", pnum(p.households, " 戶")) +
      prow("人口密度", pnum(p.density, " 人/km²")) + prow("性別比", pnum(p.sex_ratio)) +
      prow("老化指數", pnum(p.aging_index)) + prow("扶養比", pnum(p.dep_ratio, " %")) +
      prow("高齡比例(65+)", pnum(p.elderly_share, " %")) + prow("幼年比例(0-14)", pnum(p.child_share, " %")) +
      "</table>";

    html += "<h2>開放空間 · 綠地(半徑 " + pnum(g.radius_m, " m") + ")</h2><table>" +
      prow("最近綠地距離", pnum(g.nearest_dist_m, " m")) + prow("最近綠地面積", pnum(g.nearest_area_ha, " 公頃")) +
      prow("300m 內綠地", pnum(g.count_300m, " 處")) + prow("300m 內面積", pnum(g.area_300m_ha, " 公頃")) +
      prow("500m 內綠地", pnum(g.count_500m, " 處")) + prow("500m 內面積", pnum(g.area_500m_ha, " 公頃")) +
      prow("3-30-300 可及性", g.has_300m_access === undefined ? "—" : (g.has_300m_access ? "達標" : "不足")) +
      "</table>";

    html += "<h2>熱環境 · 健康研判</h2><table>" +
      prow("綠覆率(OSM下限)", pnum(h.green_coverage_pct, " %")) +
      prow("對 30% 目標", h.meets_30pct_target === undefined ? "—" : (h.meets_30pct_target ? "達標" : "不足")) +
      prow("高溫脆弱度", h.vulnerability_level || "—") +
      "</table>";

    html += "<h2>AI 綜合解讀</h2><div class='pr-ai'>" + aiHtml + "</div>";

    html += "<h2>資料來源與免責</h2><p class='pr-src'>" +
      "底圖:NLSC;界線:NLSC / taiwan-atlas;人口:內政部戶政司 ODRP014(11412);" +
      "綠地:© OpenStreetMap 貢獻者(ODbL)/ Overpass;地名:OSM Nominatim;AI:Anthropic Claude。<br>" +
      "免責:綠地與綠覆率為即時查詢之下限估計;熱環境/健康為研判而非實測。本報告僅供規劃參考,不構成正式法定文件。</p>";

    html += "</div>";
    printArea.innerHTML = html;
    return true;
  }

  exportBtn.addEventListener("click", function () {
    if (!buildPrintArea()) {
      aiSource.textContent = "請先放標記/畫基地並按「分析周邊綠地」,有數據後再匯出報告。";
      return;
    }
    window.print();
  });

  // 在地圖右下角標示資料來源(Leaflet attribution 已含 NLSC)
  map.attributionControl.setPrefix(
    '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>'
  );
})();
