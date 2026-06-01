/* ============================================================================
 * comments-layer.js
 * 使用者意見圖層 · User Comments Layer —— HEALS 基地分析工作站
 *
 * 功能:上傳含經緯度與意見(comment)的 Excel(.xlsx)或 CSV,解析為點位,
 *   依「選定地點附近」或「選定區域範圍內」篩選,於地圖標示,並做意見摘要:
 *   (1) 本地詞頻統計(零傳輸、隱私最佳)
 *   (2) 交給 AI 主題摘要(由 app.js 併入 lastAnalysis 後送出)
 *
 * 相依:Leaflet(L 全域,站上已有);.xlsx 解析用 SheetJS(XLSX 全域,動態載入)。
 * 暴露 window.CommentsLayer:
 *   parseFile(file) -> Promise<{rows, columns}>          解析檔案為列陣列與欄名
 *   detectColumns(columns) -> {lat,lng,comment}          自動偵測欄位名
 *   buildPoints(rows, map) -> [{lat,lng,comment,raw}]    依欄位對應產生點位(過濾無效座標)
 *   filterByPolygon(points, geojsonPolygon) -> points    範圍內(面模式)
 *   filterByRadius(points, lat, lng, meters) -> points    半徑內(點模式)
 *   summarize(points, opts) -> {total, topWords, samples} 本地詞頻統計
 *   ========================================================================== */
(function (global) {
  "use strict";

  var XLSX_CDN = "https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js";
  var DETOUR = 1.0;

  // 常見欄名候選(小寫比對),涵蓋中英
  var LAT_KEYS = ["lat", "latitude", "緯度", "y", "緯度(y)", "lat_y"];
  var LNG_KEYS = ["lng", "lon", "long", "longitude", "經度", "x", "經度(x)", "lng_x"];
  var COMMENT_KEYS = ["comment", "comments", "意見", "評論", "留言", "註解", "備註", "回饋", "feedback", "note", "remark", "描述", "說明"];

  // 動態載入 SheetJS(僅在需要讀 .xlsx 時)
  function ensureXLSX() {
    if (global.XLSX) return Promise.resolve(global.XLSX);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = XLSX_CDN;
      s.onload = function () { global.XLSX ? resolve(global.XLSX) : reject(new Error("XLSX load failed")); };
      s.onerror = function () { reject(new Error("XLSX CDN error")); };
      document.head.appendChild(s);
    });
  }

  // 簡易 CSV 解析(支援雙引號包覆、引號內逗號與換行)
  function parseCSV(text) {
    var rows = [], row = [], cur = "", inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ",") { row.push(cur); cur = ""; }
        else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
        else if (c === "\r") { /* skip */ }
        else cur += c;
      }
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    if (!rows.length) return { columns: [], rows: [] };
    var header = rows[0].map(function (h) { return String(h).trim(); });
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      if (rows[r].length === 1 && rows[r][0] === "") continue; // 空行
      var obj = {};
      header.forEach(function (h, idx) { obj[h] = rows[r][idx] != null ? rows[r][idx] : ""; });
      out.push(obj);
    }
    return { columns: header, rows: out };
  }

  // 解析檔案(依副檔名走 CSV 或 xlsx),回傳 {columns, rows}
  function parseFile(file) {
    var name = (file.name || "").toLowerCase();
    if (name.endsWith(".csv") || file.type === "text/csv") {
      return file.text().then(function (txt) { return parseCSV(txt); });
    }
    // .xlsx / .xls
    return ensureXLSX().then(function (XLSX) {
      return file.arrayBuffer().then(function (buf) {
        var wb = XLSX.read(buf, { type: "array" });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        var columns = rows.length ? Object.keys(rows[0]) : [];
        return { columns: columns, rows: rows };
      });
    });
  }

  function pickColumn(columns, candidates) {
    var lower = columns.map(function (c) { return String(c).trim().toLowerCase(); });
    // 1) 完全相等
    for (var i = 0; i < candidates.length; i++) {
      var idx = lower.indexOf(candidates[i]);
      if (idx >= 0) return columns[idx];
    }
    // 2) 包含
    for (var j = 0; j < lower.length; j++) {
      for (var k = 0; k < candidates.length; k++) {
        if (lower[j].indexOf(candidates[k]) >= 0) return columns[j];
      }
    }
    return null;
  }

  function detectColumns(columns) {
    return {
      lat: pickColumn(columns, LAT_KEYS),
      lng: pickColumn(columns, LNG_KEYS),
      comment: pickColumn(columns, COMMENT_KEYS)
    };
  }

  function toNum(v) {
    if (typeof v === "number") return v;
    if (v == null) return NaN;
    return parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  }

  // 依欄位對應產生點位;過濾無效或超出台灣概略範圍的座標
  function buildPoints(rows, cols) {
    var out = [];
    rows.forEach(function (r) {
      var lat = toNum(r[cols.lat]), lng = toNum(r[cols.lng]);
      if (!isFinite(lat) || !isFinite(lng)) return;
      // 容錯:若疑似經緯顛倒(lat 在台灣經度範圍),自動對調
      if (lat > 100 && lng < 35) { var tmp = lat; lat = lng; lng = tmp; }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      out.push({ lat: lat, lng: lng, comment: cols.comment ? String(r[cols.comment] || "") : "", raw: r });
    });
    return out;
  }

  function haversine(aLat, aLng, bLat, bLng) {
    var R = 6371000, t = Math.PI / 180;
    var dLat = (bLat - aLat) * t, dLng = (bLng - aLng) * t;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(aLat * t) * Math.cos(bLat * t) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function filterByRadius(points, lat, lng, meters) {
    return points.filter(function (p) {
      return haversine(lat, lng, p.lat, p.lng) * DETOUR <= meters;
    });
  }

  // 點是否在 GeoJSON Polygon 內(射線法;使用外環,夠用於篩選)
  function pointInPolygon(lat, lng, geojson) {
    var geom = geojson.geometry || geojson;
    var polys = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
    for (var pi = 0; pi < polys.length; pi++) {
      var ring = polys[pi][0]; // 外環
      var inside = false;
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        var intersect = ((yi > lat) !== (yj > lat)) &&
          (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  function filterByPolygon(points, geojson) {
    return points.filter(function (p) { return pointInPolygon(p.lat, p.lng, geojson); });
  }

  // 中英停用詞(精簡)
  var STOP = (
    "的 了 是 在 我 有 和 也 都 與 及 或 而 就 很 太 非常 這 那 這裡 那裡 一個 沒有 不會 不要 因為 所以 但是 " +
    "the a an and or of to in is are was for on at it this that with as be by we you they i").split(/\s+/);
  var STOPSET = {}; STOP.forEach(function (w) { STOPSET[w] = 1; });

  // 斷詞:英文按詞、中文按 2-gram(無斷詞庫的務實折衷)
  function tokenize(text) {
    var tokens = [];
    // 英文/數字詞
    (text.toLowerCase().match(/[a-z0-9]{2,}/g) || []).forEach(function (w) {
      if (!STOPSET[w]) tokens.push(w);
    });
    // 中文 2-gram
    var han = text.match(/[一-鿿]+/g) || [];
    han.forEach(function (seg) {
      for (var i = 0; i < seg.length - 1; i++) {
        var bg = seg.substr(i, 2);
        if (!STOPSET[bg]) tokens.push(bg);
      }
      if (seg.length === 1) tokens.push(seg);
    });
    return tokens;
  }

  // 本地詞頻統計 + 代表性原句
  function summarize(points, opts) {
    opts = opts || {};
    var topN = opts.topN || 12, sampleN = opts.sampleN || 5;
    var freq = {}, withComment = 0;
    points.forEach(function (p) {
      var c = (p.comment || "").trim();
      if (!c) return;
      withComment++;
      var seen = {};
      tokenize(c).forEach(function (tok) {
        if (seen[tok]) return; seen[tok] = 1; // 每則意見每詞只計一次,避免長文灌票
        freq[tok] = (freq[tok] || 0) + 1;
      });
    });
    var topWords = Object.keys(freq).map(function (w) { return { word: w, count: freq[w] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, topN);
    // 代表性原句:含最高頻詞者優先,去重、截長
    var samples = [];
    if (topWords.length) {
      var key = topWords[0].word, seen = {};
      points.forEach(function (p) {
        var c = (p.comment || "").trim();
        if (!c || seen[c]) return;
        if (c.toLowerCase().indexOf(key) >= 0 && samples.length < sampleN) { samples.push(c); seen[c] = 1; }
      });
      // 不足則補其他意見
      if (samples.length < sampleN) {
        points.forEach(function (p) {
          var c = (p.comment || "").trim();
          if (!c || seen[c] || samples.length >= sampleN) return;
          samples.push(c); seen[c] = 1;
        });
      }
    }
    return { total: points.length, withComment: withComment, topWords: topWords, samples: samples };
  }

  global.CommentsLayer = {
    parseFile: parseFile,
    detectColumns: detectColumns,
    buildPoints: buildPoints,
    filterByPolygon: filterByPolygon,
    filterByRadius: filterByRadius,
    summarize: summarize,
    LAT_KEYS: LAT_KEYS, LNG_KEYS: LNG_KEYS, COMMENT_KEYS: COMMENT_KEYS
  };
})(typeof window !== "undefined" ? window : this);
