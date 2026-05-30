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
      return;
    }
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

  function fetchWithTimeout(url, ms) {
    if (typeof AbortController === "undefined") {
      return fetch(url); // 舊瀏覽器退回,無逾時控制
    }
    var ctrl = new AbortController();
    var t = setTimeout(function () {
      ctrl.abort();
    }, ms);
    return fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } }).finally(
      function () {
        clearTimeout(t);
      }
    );
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

  // 在地圖右下角標示資料來源(Leaflet attribution 已含 NLSC)
  map.attributionControl.setPrefix(
    '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>'
  );
})();
