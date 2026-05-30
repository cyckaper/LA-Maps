/* Netlify Function: POST /api/analyze
 * 與 Cloudflare 版同邏輯,改用 Netlify Functions 2.0(標準 Request/Response + process.env)。
 * 金鑰存於環境變數 ANTHROPIC_API_KEY(於 Netlify 後台設定,前端不外露)。
 */

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `你是台灣的都市規劃與基地分析助理。請依使用者提供的「真實數值(JSON)」撰寫一份繁體中文的基地分析報告。

嚴格規則:
1. 只能根據提供的數值與下列法規/準則進行解讀,不可自行編造任何數字、人口、面積或法條。
2. 數值缺漏(null 或「—」)時,明白指出「資料不足」,不要臆測。
3. 綠地、綠覆率來自 OpenStreetMap 即時查詢,屬「下限估計」,可能不完整;熱環境/健康為「研判」,非實測氣溫或疾病數據——報告中須明確標示這些限制。
4. 引用法規時使用下方提供的條文,不要引用未提供的細部數字或地方自治條例。

可引用的法規與準則:
- 都市計畫法 §45:公園、綠地、廣場、兒童遊樂場用地占用土地總面積不得少於全部計畫面積 10%。
- 都市計畫定期通盤檢討實施辦法:兒童遊樂場每處 ≥0.1 公頃;閭鄰公園每處 ≥0.5 公頃;社區公園(10萬人以上計畫處所)≥4 公頃。
- 3-30-300 綠地準則(實證導向):住家可見 3 棵樹、鄰里 30% 樹冠覆蓋、住家 300 公尺內有綠地/公園。
- 老化指數 = 65歲以上人口 ÷ 0-14歲人口 ×100;扶養比、扶幼比、扶老比為人口依賴負擔指標。

5. 若提供 biodiversity 欄位,以其物種數、觀測筆數、受脅物種、分類群組成評估生態/生物多樣性現況;iNaturalist 為社群觀測,涵蓋度依地區而異,屬參考性指標而非完整生態調查,須標示此限制。

報告結構(用簡短段落與條列,務求精煉好讀):
一、基地概述(位置、所在行政區、人口結構重點)
二、開放空間與綠地評估(可及性、綠覆、對照法規/準則,符合或不足)
三、熱環境與健康研判(高溫脆弱度與成因、敏感族群,標示為研判)
四、生態與生物多樣性(若有 biodiversity 資料:物種豐富度、分類群、受脅物種,標示 iNaturalist 涵蓋度限制;無資料則略過)
五、規劃建議(2-4 點,具體、可行,扣回前述數據與法規)
六、資料與限制說明(資料來源、代理指標、不確定性)

語氣:專業、客觀、精準。全文約 400-700 字。`;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type"
    }
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "僅支援 POST。" }, 405);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return json({ error: "伺服器尚未設定 ANTHROPIC_API_KEY(請於 Netlify 後台設定環境變數)。" }, 500);
  }

  let data;
  try {
    data = await req.json();
  } catch (e) {
    return json({ error: "請求格式錯誤(需為 JSON)。" }, 400);
  }

  const userContent =
    "以下是某基地的分析真實數值(JSON)。請據此撰寫繁體中文基地分析報告:\n\n" +
    "```json\n" + JSON.stringify(data, null, 2) + "\n```";

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        stream: true, // 串流:邊產生邊回傳,避免 Netlify 閒置逾時(504)
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userContent }]
      })
    });
  } catch (e) {
    return json({ error: "呼叫 AI 服務失敗:" + (e && e.message ? e.message : String(e)) }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    let msg = "AI 服務回應錯誤(HTTP " + upstream.status + ")。";
    try { const j = await upstream.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
    return json({ error: msg }, upstream.status || 502);
  }

  // 解析 Anthropic SSE,逐塊把文字 delta 以純文字串流回前端
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const evt = JSON.parse(payload);
              if (evt.type === "content_block_delta" && evt.delta && evt.delta.text) {
                controller.enqueue(encoder.encode(evt.delta.text));
              }
            } catch (e) { /* 忽略非 JSON 行 */ }
          }
        }
      } catch (e) {
        controller.enqueue(encoder.encode("\n\n(串流中斷:" + (e.message || e) + ")"));
      }
      controller.close();
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*"
    }
  });
};

// Netlify Functions 2.0:直接把此函式掛在 /api/analyze
export const config = { path: "/api/analyze" };
