/* Phase 2 資料建置腳本(在 GitHub Actions 執行,runner 有完整網路)
 *
 * 產出(寫入 public/data/):
 *   towns.json     鄉鎮市區界線 GeoJSON,properties 內含人口指標
 *   villages.json  村里界線 GeoJSON,properties 內含人口指標
 *   meta.json      資料來源、統計期、對應率等
 *
 * 資料來源:
 *   界線 — dkaoster/taiwan-atlas(TopoJSON, MIT, 內政部國土測繪 村里界圖)
 *   人口 — 內政部戶政司 rs-opendata(村里戶數、單一年齡人口,JSON,免金鑰)
 *
 * 設計原則:界線一定要成功;人口抓取/解析失敗時印出警告但仍輸出界線,
 *           讓前端的空間對應功能可先驗證,人口再迭代。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { feature } from "topojson-client";

const OUT_DIR = "public/data";

const SRC = {
  townsTopo: "https://cdn.jsdelivr.net/npm/taiwan-atlas/towns-10t.json",
  villTopo: "https://cdn.jsdelivr.net/npm/taiwan-atlas/villages-10t.json"
};

// 戶政司 rs-opendata:村里戶數、單一年齡人口。逐月嘗試最近數期,取第一個有資料者。
const RIS_BASE = "https://www.ris.gov.tw/rs-opendata/api/v1/datastore";
const RIS_DATASETS = ["ODRP005", "ODRP019"]; // 候選資料集代碼(單一年齡人口)

// 抓取診斷(寫入 meta.json,供建置後校驗實際情形)
const DIAG = [];

// ---------- 共用 ----------
function log(...a) { console.log("[build-data]", ...a); }
function warn(...a) { console.warn("[build-data][WARN]", ...a); }

async function fetchRetry(url, { asText = false, tries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "LA-Maps-build/1.0" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return asText ? await res.text() : await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

// 近 N 個民國年月字串(yyymm),由新到舊
function recentYyymm(n) {
  const out = [];
  const now = new Date();
  let y = now.getFullYear() - 1911;
  let m = now.getMonth() + 1;
  for (let i = 0; i < n; i++) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m--;
    if (m === 0) { m = 12; y--; }
  }
  return out;
}

// ---------- 大地測量多邊形面積(m²)----------
const EARTH_R = 6378137;
const toRad = (d) => (d * Math.PI) / 180;
function ringArea(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [lo1, la1] = ring[i];
    const [lo2, la2] = ring[(i + 1) % n];
    total += toRad(lo2 - lo1) * (2 + Math.sin(toRad(la1)) + Math.sin(toRad(la2)));
  }
  return Math.abs((total * EARTH_R * EARTH_R) / 2);
}
function geomArea(geom) {
  if (!geom) return 0;
  if (geom.type === "Polygon") {
    return geom.coordinates.reduce(
      (s, ring, i) => s + (i === 0 ? ringArea(ring) : -ringArea(ring)),
      0
    );
  }
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.reduce(
      (s, poly) =>
        s + poly.reduce((ps, ring, i) => ps + (i === 0 ? ringArea(ring) : -ringArea(ring)), 0),
      0
    );
  }
  return 0;
}

// ---------- 人口資料解析(自動偵測欄位)----------
// 回傳 Map<site_id, {hh, male, female, age0_14, age15_64, age65up}>
function accumulateRows(rows, acc) {
  let detected = null;
  for (const row of rows) {
    // 區域代碼(優先 district_code 數字碼;site_id 常為中文名稱不可當鍵)
    const sid =
      row.district_code || row.DISTRICT_CODE || row.site_id || row.SITE_ID ||
      row.village_id || row.area_code || row.code;
    if (!sid) continue;
    const key = String(sid).trim();
    let rec = acc.get(key);
    if (!rec) {
      rec = { hh: 0, male: 0, female: 0, a0_14: 0, a15_64: 0, a65: 0 };
      acc.set(key, rec);
    }
    for (const [k, vRaw] of Object.entries(row)) {
      const v = Number(String(vRaw).replace(/[, ]/g, ""));
      if (!Number.isFinite(v)) continue;
      const lk = k.toLowerCase();
      // 戶數
      if (/household|戶數|^household_no$/.test(lk) || /戶數/.test(k)) {
        rec.hh += v;
        continue;
      }
      // 年齡:抓出數字(單一年齡欄通常含 age 與數字,或中文「N歲」)
      let age = null;
      const mAge = lk.match(/(?:age|歲|_)(\d{1,3})/);
      const cAge = k.match(/(\d{1,3})\s*歲/);
      if (cAge) age = parseInt(cAge[1], 10);
      else if (mAge) age = parseInt(mAge[1], 10);
      if (/(100|百).*(以上|up|over)|(以上|up|over)/.test(k + lk) && age === null) age = 100;
      if (age === null) continue;
      const isMale = /(_m\b|_m_|男|male)/.test(k) || /m$/.test(lk);
      const isFemale = /(_f\b|_f_|女|female)/.test(k) || /f$/.test(lk);
      if (isMale) rec.male += v;
      else if (isFemale) rec.female += v;
      if (age <= 14) rec.a0_14 += v;
      else if (age <= 64) rec.a15_64 += v;
      else rec.a65 += v;
      if (!detected) detected = k;
    }
  }
  return detected;
}

// 帶逾時的單次抓取,回傳豐富診斷
async function probe(url) {
  const out = {
    url, status: null, ctype: null, respKeys: null,
    code: null, msg: null, rows: 0, keys: null, snippet: null, error: null, data: null
  };
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "LA-Maps-build/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(12000)
    });
    out.status = res.status;
    out.ctype = res.headers.get("content-type");
    const text = await res.text();
    out.snippet = text.slice(0, 220);
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      out.error = "JSON parse failed";
      return out;
    }
    out.respKeys = Object.keys(data);
    out.code = data.responseCode != null ? String(data.responseCode) : null;
    out.msg = data.responseMessage != null ? String(data.responseMessage) : null;
    const rows =
      data.responseData || (data.result && data.result.records) || data.records ||
      (Array.isArray(data) ? data : []);
    if (Array.isArray(rows)) {
      out.rows = rows.length;
      if (rows.length) out.keys = Object.keys(rows[0]);
      out.data = rows;
    }
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
  }
  return out;
}

function diagOf(p) {
  // 移除大筆 data 後存入診斷
  return {
    url: p.url, status: p.status, ctype: p.ctype, respKeys: p.respKeys,
    responseCode: p.code, responseMessage: p.msg, rows: p.rows, keys: p.keys,
    snippet: p.snippet, error: p.error
  };
}

function pickSiteId(row) {
  if (!row) return null;
  const sid =
    row.site_id || row.SITE_ID || row.village_id || row.area_code || row.code;
  return sid != null ? String(sid) : null;
}

// 已知最佳人口資料集:ODRP014「現住人口數按性別及年齡(村里)」,
// 含 people_age_000..100 × 男女,可算出所有指標。優先直接使用,失敗才全面掃描。
const PRIMARY_CODE = "ODRP014";

// 退回機制:全面掃描候選代碼與期別(亦因應未來代碼/期別變動)
const CODE_SWEEP = [];
for (let i = 1; i <= 30; i++) CODE_SWEEP.push("ODRP" + String(i).padStart(3, "0"));
// 期別由近月優先,讓直接命中更快(月別資料用 yyymm、年度資料用 yyy)
const SWEEP_PERIODS = ["11412", "11411", "11410", "11409", "11312", "114", "113"];

// 單一代碼:逐期別嘗試,回傳第一個有資料者
async function probeCode(code) {
  for (const ym of SWEEP_PERIODS) {
    const p = await probe(`${RIS_BASE}/${code}/${ym}?page=1`);
    if (p.rows > 0 && p.data) {
      return {
        code, period: ym, cols: (p.keys || []).length,
        keys: p.keys, firstRows: p.data, diag: diagOf(p)
      };
    }
  }
  return null;
}

// 並行掃描(分批)以縮短建置時間
async function discover() {
  const found = [];
  const BATCH = 6;
  for (let i = 0; i < CODE_SWEEP.length; i += BATCH) {
    const batch = CODE_SWEEP.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(probeCode));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r) {
        found.push(r);
        DIAG.push({ ds: r.code, ym: r.period, ...r.diag });
        log(`發現 ${r.code}/${r.period}: ${r.cols} 欄`);
      }
    }
  }
  return found;
}

async function loadPopulation() {
  const acc = new Map();

  // 先直接嘗試已知最佳資料集,命中即用,省去全面掃描
  let primary = await probeCode(PRIMARY_CODE);
  let found;
  if (primary) {
    found = [primary];
    DIAG.push({ ds: primary.code, ym: primary.period, ...primary.diag });
    log(`直接命中 ${primary.code}/${primary.period}(${primary.cols} 欄)`);
  } else {
    log(`${PRIMARY_CODE} 未命中,改全面掃描 ODRP001-030…`);
    found = await discover();
    if (found.length === 0) {
      warn("掃描所有候選資料集皆查無資料,將只輸出界線。");
      return {
        acc, dataset: null, period: null, sampleKeys: [],
        sampleSiteId: null, sampleCodes: [], discovered: []
      };
    }
    // 單一年齡人口欄位數最多(0~100歲 × 男女 → 200+ 欄),以欄位數最多者為主
    found.sort((a, b) => b.cols - a.cols);
    primary = found[0];
    log(`選用人口資料集 ${primary.code}/${primary.period}(${primary.cols} 欄)`);
  }

  accumulateRows(primary.firstRows, acc);
  for (let page = 2; page <= 80; page++) {
    const p = await probe(`${RIS_BASE}/${primary.code}/${primary.period}?page=${page}`);
    if (!(p.rows > 0 && p.data)) break;
    accumulateRows(p.data, acc);
  }
  log(`人口資料 ${primary.code}/${primary.period}:對應鍵數 ${acc.size}`);

  return {
    acc, dataset: primary.code, period: primary.period,
    sampleKeys: primary.keys || [],
    sampleSiteId:
      primary.firstRows[0] && primary.firstRows[0].site_id != null
        ? String(primary.firstRows[0].site_id)
        : null,
    sampleCodes: primary.firstRows.slice(0, 3).map(
      (r) => r.district_code || r.site_id || null
    ),
    discovered: found.map((f) => ({ code: f.code, period: f.period, cols: f.cols }))
  };
}

// ---------- 指標計算 ----------
function indicators(rec, areaM2) {
  if (!rec) {
    return {
      pop: null, households: null, male: null, female: null,
      sex_ratio: null, household_size: null, density: null,
      aging_index: null, dep_ratio: null, child_dep: null, old_dep: null
    };
  }
  const pop = rec.male + rec.female || rec.a0_14 + rec.a15_64 + rec.a65;
  const km2 = areaM2 / 1e6;
  const r1 = (a, b) => (b > 0 ? +((a / b) * 100).toFixed(2) : null);
  return {
    pop: pop || null,
    households: rec.hh || null,
    male: rec.male || null,
    female: rec.female || null,
    sex_ratio: rec.female > 0 ? +((rec.male / rec.female) * 100).toFixed(2) : null,
    household_size: rec.hh > 0 ? +(pop / rec.hh).toFixed(2) : null,
    density: km2 > 0 && pop ? +(pop / km2).toFixed(1) : null,
    aging_index: r1(rec.a65, rec.a0_14),
    child_dep: r1(rec.a0_14, rec.a15_64),
    old_dep: r1(rec.a65, rec.a15_64),
    dep_ratio: r1(rec.a0_14 + rec.a65, rec.a15_64)
  };
}

// ---------- 主流程 ----------
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  log("下載界線(taiwan-atlas)…");
  const townsTopo = await fetchRetry(SRC.townsTopo);
  const villTopo = await fetchRetry(SRC.villTopo);
  const pickObj = (topo, preferred) =>
    topo.objects[preferred] || topo.objects[Object.keys(topo.objects)[0]];
  const towns = feature(townsTopo, pickObj(townsTopo, "towns"));
  const villages = feature(villTopo, pickObj(villTopo, "villages"));
  log(`界線:鄉鎮市區 ${towns.features.length} 個、村里 ${villages.features.length} 個`);
  log("鄉鎮樣本屬性:", JSON.stringify(towns.features[0] && towns.features[0].properties));
  log("村里樣本屬性:", JSON.stringify(villages.features[0] && villages.features[0].properties));

  const { acc, dataset, period, sampleKeys, sampleSiteId, sampleCodes, discovered } =
    await loadPopulation();

  // 村里:逐一對應 + 計算面積/指標;同時依 TOWNCODE 聚合到鄉鎮
  const townAgg = new Map(); // TOWNCODE -> {hh,male,female,a0_14,a15_64,a65, area}
  let villMatched = 0;

  for (const f of villages.features) {
    const p = f.properties;
    const code = String(p.VILLCODE || "").trim();
    const areaM2 = geomArea(f.geometry);
    const rec = acc.get(code);
    if (rec) villMatched++;
    f.properties = {
      VILLCODE: code,
      VILLNAME: p.VILLNAME,
      TOWNCODE: p.TOWNCODE,
      TOWNNAME: p.TOWNNAME,
      COUNTYNAME: p.COUNTYNAME,
      area_km2: +(areaM2 / 1e6).toFixed(4),
      ...indicators(rec, areaM2)
    };
    // 聚合到鄉鎮
    const tc = String(p.TOWNCODE || "").trim();
    let ta = townAgg.get(tc);
    if (!ta) {
      ta = { hh: 0, male: 0, female: 0, a0_14: 0, a15_64: 0, a65: 0, area: 0 };
      townAgg.set(tc, ta);
    }
    ta.area += areaM2;
    if (rec) {
      ta.hh += rec.hh; ta.male += rec.male; ta.female += rec.female;
      ta.a0_14 += rec.a0_14; ta.a15_64 += rec.a15_64; ta.a65 += rec.a65;
    }
  }

  for (const f of towns.features) {
    const p = f.properties;
    const tc = String(p.TOWNCODE || "").trim();
    const ta = townAgg.get(tc);
    const areaM2 = ta ? ta.area : geomArea(f.geometry);
    const rec = ta && (ta.male + ta.female) > 0 ? ta : null;
    f.properties = {
      TOWNCODE: tc,
      TOWNNAME: p.TOWNNAME,
      COUNTYNAME: p.COUNTYNAME,
      area_km2: +(areaM2 / 1e6).toFixed(4),
      ...indicators(rec, areaM2)
    };
  }

  const matchRate = villages.features.length
    ? ((villMatched / villages.features.length) * 100).toFixed(1)
    : "0";
  log(`村里人口對應率:${villMatched}/${villages.features.length} (${matchRate}%)`);

  writeFileSync(`${OUT_DIR}/towns.json`, JSON.stringify(towns));
  writeFileSync(`${OUT_DIR}/villages.json`, JSON.stringify(villages));
  writeFileSync(
    `${OUT_DIR}/meta.json`,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        boundary_source: "dkaoster/taiwan-atlas (MIT)",
        population_source: dataset
          ? `內政部戶政司 rs-opendata ${dataset}`
          : "(人口資料未取得)",
        population_period: period,
        population_sample_keys: sampleKeys,
        population_sample_site_id: sampleSiteId,
        population_sample_codes: sampleCodes,
        discovered_datasets: discovered,
        town_count: towns.features.length,
        village_count: villages.features.length,
        village_match_rate: matchRate + "%",
        // 界線代碼樣本(供與人口 site_id 比對格式)
        boundary_villcode_samples: villages.features.slice(0, 3).map((f) => f.properties.VILLCODE),
        boundary_towncode_samples: towns.features.slice(0, 3).map((f) => f.properties.TOWNCODE),
        // 人口抓取診斷(每個 dataset/月份首頁的 HTTP 狀態與回應摘要)
        fetch_diagnostics: DIAG
      },
      null,
      2
    )
  );
  log("完成,輸出至", OUT_DIR);

  if (villMatched === 0) {
    warn("人口對應率為 0 —— 界線已輸出,但指標全空。請檢查上方樣本欄位以調整解析。");
  }
}

main().catch((e) => {
  console.error("[build-data][FATAL]", e);
  process.exit(1);
});
