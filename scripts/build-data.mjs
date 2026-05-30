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
const RIS_DATASETS = ["ODRP019", "ODRP005"]; // 候選資料集代碼(單一年齡人口)

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
    // site_id / 區域代碼
    const sid =
      row.site_id || row.SITE_ID || row.village_id || row.area_code || row.code;
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

async function loadPopulation() {
  const acc = new Map();
  for (const ds of RIS_DATASETS) {
    for (const ym of recentYyymm(6)) {
      try {
        let page = 1, got = 0, sample = null;
        for (;;) {
          const url = `${RIS_BASE}/${ds}/${ym}?page=${page}`;
          const data = await fetchRetry(url);
          const rows = data.responseData || data.result?.records || data.records || [];
          if (!Array.isArray(rows) || rows.length === 0) break;
          if (!sample) sample = rows[0];
          accumulateRows(rows, acc);
          got += rows.length;
          page++;
          if (page > 60) break; // 安全上限
        }
        if (got > 0) {
          log(`人口資料 ${ds}/${ym}:取得 ${got} 列,site 數 ${acc.size}`);
          log("樣本欄位:", Object.keys(sample).join(", "));
          return { acc, dataset: ds, period: ym, sampleKeys: Object.keys(sample) };
        }
      } catch (e) {
        // 這個年月沒有,換下一個
      }
    }
  }
  warn("所有候選人口資料來源皆無法取得,將只輸出界線(指標留空)。");
  return { acc, dataset: null, period: null, sampleKeys: [] };
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

  const { acc, dataset, period, sampleKeys } = await loadPopulation();

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
        town_count: towns.features.length,
        village_count: villages.features.length,
        village_match_rate: matchRate + "%"
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
