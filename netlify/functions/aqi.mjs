/* Netlify Function: GET /api/aqi
 * 代理環境部空氣品質指標(AQI)開放資料 aqx_p_432。
 * 金鑰存於環境變數 MOENV_API_KEY(於 Netlify 後台設定,前端不外露)。
 * 政府 API 需 api_key 且未必支援瀏覽器 CORS,故經此後端代理。
 * 回傳精簡測站清單(含經緯度),前端自行算最近測站。
 */

const MOENV_AQI = "https://data.moenv.gov.tw/api/v2/aqx_p_432";

function json(obj, status = 200, cache = false) {
  // 僅「有資料的成功回應」才快取(由呼叫端決定);錯誤或空結果一律 no-store,
  // 避免「尚未設定」「查無資料」等暫時性結果被 CDN/瀏覽器快取 10 分鐘而卡住。
  const ok = status >= 200 && status < 300;
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": (ok && cache) ? "public, max-age=600" : "no-store" // AQI 每小時更新,有資料才快取 10 分鐘
    }
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  const key = process.env.MOENV_API_KEY;
  if (!key) {
    return json({ error: "伺服器尚未設定 MOENV_API_KEY(請於 Netlify 後台設定環境變數)。" }, 500);
  }

  const url = MOENV_AQI + "?language=zh&offset=0&limit=1000&api_key=" + encodeURIComponent(key);
  let upstream;
  try {
    upstream = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    return json({ error: "呼叫環境部 AQI 服務失敗:" + (e && e.message ? e.message : String(e)) }, 502);
  }
  if (!upstream.ok) {
    return json({ error: "環境部 AQI 服務回應錯誤(HTTP " + upstream.status + ")。" }, upstream.status || 502);
  }

  let data;
  try { data = await upstream.json(); } catch (e) {
    return json({ error: "環境部 AQI 回應非預期格式。" }, 502);
  }

  // 環境部 v2 通常為 data.records,但不同資料集/版本也可能放在 result.records 或 data 陣列
  const records = Array.isArray(data.records) ? data.records
    : (data.result && Array.isArray(data.result.records)) ? data.result.records
    : Array.isArray(data) ? data : [];

  // 依候選欄位名(不分大小寫)取值,因應環境部欄位命名差異
  const pick = (r, names) => {
    for (const n of names) {
      if (r[n] != null && r[n] !== "") return r[n];
    }
    // 大小寫不敏感退路
    const lowerMap = {};
    for (const k of Object.keys(r)) lowerMap[k.toLowerCase()] = r[k];
    for (const n of names) {
      const v = lowerMap[n.toLowerCase()];
      if (v != null && v !== "") return v;
    }
    return undefined;
  };
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };

  const stations = records.map((r) => {
    const lat = num(pick(r, ["latitude", "lat", "twd97lat", "y"]));
    const lng = num(pick(r, ["longitude", "lon", "lng", "twd97lon", "x"]));
    if (lat == null || lng == null) return null;
    return {
      site: pick(r, ["sitename", "site", "站名"]) || "",
      county: pick(r, ["county", "縣市"]) || "",
      aqi: (() => { const v = pick(r, ["aqi", "AQI"]); const n = parseInt(v, 10); return isFinite(n) ? n : null; })(),
      status: pick(r, ["status", "狀態"]) || "",
      pollutant: pick(r, ["pollutant", "主要污染物"]) || "",
      pm25: num(pick(r, ["pm2.5", "pm25", "PM2.5"])),
      pm10: num(pick(r, ["pm10", "PM10"])),
      o3: num(pick(r, ["o3", "O3"])),
      publishtime: pick(r, ["publishtime", "datacreationdate", "發布時間"]) || "",
      lat: lat, lng: lng
    };
  }).filter(Boolean);

  const out = { stations: stations, count: stations.length };
  // 診斷:當原始有資料卻全被濾除(多半是欄位名不符),回傳樣本以利定位
  if (stations.length === 0) {
    out.rawCount = records.length;
    out.sampleKeys = records.length ? Object.keys(records[0]) : Object.keys(data);
    out.responseKeys = Object.keys(data);
  }
  // 僅當有測站資料時才允許快取;空結果不快取,避免暫時性「查無」卡住
  return json(out, 200, stations.length > 0);
};

// Netlify Functions 2.0:掛在 /api/aqi
export const config = { path: "/api/aqi" };
