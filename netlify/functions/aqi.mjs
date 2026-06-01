/* Netlify Function: GET /api/aqi
 * 代理環境部空氣品質指標(AQI)開放資料 aqx_p_432。
 * 金鑰存於環境變數 MOENV_API_KEY(於 Netlify 後台設定,前端不外露)。
 * 政府 API 需 api_key 且未必支援瀏覽器 CORS,故經此後端代理。
 * 回傳精簡測站清單(含經緯度),前端自行算最近測站。
 */

const MOENV_AQI = "https://data.moenv.gov.tw/api/v2/aqx_p_432";

function json(obj, status = 200) {
  // 僅成功回應才允許快取;錯誤回應一律 no-store,避免「尚未設定」等暫時性錯誤被 CDN/瀏覽器快取 10 分鐘
  const ok = status >= 200 && status < 300;
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": ok ? "public, max-age=600" : "no-store" // AQI 每小時更新,成功快取 10 分鐘減少呼叫
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

  const records = Array.isArray(data.records) ? data.records : [];
  // 只挑前端需要的欄位,過濾無經緯度者
  const stations = records.map((r) => {
    const lat = parseFloat(r.latitude), lng = parseFloat(r.longitude);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return {
      site: r.sitename || "",
      county: r.county || "",
      aqi: r.aqi === "" ? null : (parseInt(r.aqi, 10) || null),
      status: r.status || "",
      pollutant: r.pollutant || "",
      pm25: r["pm2.5"] === "" ? null : (parseFloat(r["pm2.5"]) || null),
      pm10: r.pm10 === "" ? null : (parseFloat(r.pm10) || null),
      o3: r.o3 === "" ? null : (parseFloat(r.o3) || null),
      publishtime: r.publishtime || "",
      lat: lat, lng: lng
    };
  }).filter(Boolean);

  return json({ stations: stations, count: stations.length });
};

// Netlify Functions 2.0:掛在 /api/aqi
export const config = { path: "/api/aqi" };
