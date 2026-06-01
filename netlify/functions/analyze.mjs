/* Netlify Function: POST /api/analyze
 * 與 Cloudflare 版同邏輯,改用 Netlify Functions 2.0(標準 Request/Response + process.env)。
 * 金鑰存於環境變數 ANTHROPIC_API_KEY(於 Netlify 後台設定,前端不外露)。
 */

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `你是台灣的都市規劃與基地分析助理。請依使用者提供的「真實數值(JSON)」撰寫一份基地分析報告。輸出語言:依使用者指示(繁體中文或 English),未指定時用繁體中文。

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

5. 若提供 biodiversity 欄位,以其物種數、觀測筆數、受脅物種數、分類群組成評估生態現況。【重要】詳細的物種名錄(代表性物種、受脅物種清單)已另以表格完整呈現,你在敘述中「不要」逐一列舉或複製物種名單;僅就整體生態特徵做定性說明(分類群是否均衡、是否有指標性類群、受脅物種數量所反映的保育意義),至多點到 1-2 種最具代表性者即可。iNaturalist 為社群觀測,涵蓋度依地區而異,屬參考性指標而非完整生態調查,須標示此限制。
6. 若提供 climate 欄位(Open-Meteo ERA5 重分析之多年平均背景值,非即時天氣),依年均溫、最熱月均溫、高溫日數、年降雨量、盛行風向、日均日射量,推導對基地設計的微氣候意涵:通風廊道與開窗方位(對應盛行風向)、遮蔭與植栽(對應高溫日數與日射量)、排水/滯洪(對應年降雨量)、氣候韌性。引用時標明為「氣候背景值」。
7. 若提供 openspace_service_level 欄位(開放空間服務水準),以其總分(overall,0-100)、等級(band)及五面向(綠地公園、運動遊憩、自行車步道、大眾運輸、公廁)的最近距離與數量,評估步行 10 分鐘生活圈的開放空間可及性與服務完整度;指出短板面向並對應規劃建議。此為 OSM/Overpass 即時查詢之下限估計,須標示限制。
8. 若提供 healing_green_intervention 欄位(療癒綠地介入需求指數),以其 index(0-100)、priority_level 與 dominant_factor(主導因子:green=綠地匱乏、vuln=脆弱族群、heat=熱壓力、access=可及性不足)研判此基地導入「療癒性綠地/療癒景觀」的優先程度,並針對主導因子提出對應的療癒景觀設計策略(如:面向高齡與幼童的療癒花園、林蔭降溫廊道、可及的鄰里口袋綠地、感官與復癒性植栽)。此為多因子加權之研判性指標,非實測健康數據,須標示為研判。

報告結構(用簡短段落與條列,務求精煉好讀):
一、基地概述(位置、所在行政區、人口結構重點)
二、開放空間與綠地評估(可及性、綠覆、對照法規/準則,符合或不足;若有 openspace_service_level 資料,納入步行 10 分鐘服務水準總分與短板面向)
三、氣候背景與微氣候(若有 climate 資料:氣溫、雨量、盛行風向、日射量及其設計意涵;無資料則略過)
四、熱環境與健康研判(高溫脆弱度與成因、敏感族群,結合氣候與綠覆綜合研判;若有 healing_green_intervention 資料,提出療癒綠地介入優先度與對應療癒景觀設計策略;標示為研判)
五、生態與生物多樣性(若有 biodiversity 資料:物種豐富度、分類群、受脅物種數的定性說明,標示 iNaturalist 涵蓋度限制;切勿列舉物種清單;無資料則略過)
六、規劃建議(2-4 點,具體、可行,扣回前述數據與法規)
七、資料與限制說明(資料來源、代理指標、不確定性)

語氣:專業、客觀、精準。全文控制在約 500-700 字(英文版約 350-500 words),寧可精煉也不要冗長;務必完整寫到「資料與限制說明」一節作結,不可中途停筆或在列舉清單處打住。`;

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

  const lang = data && data.lang === "en" ? "en" : "zh";

  // 意見摘要模式:只摘要使用者上傳之意見主題,不走完整基地報告
  const isComments = data && data.mode === "comments_summary";
  let systemPrompt = SYSTEM_PROMPT;
  let userContent;
  if (isComments) {
    const comments = Array.isArray(data.comments) ? data.comments.filter(function (c) { return c && String(c).trim(); }) : [];
    systemPrompt = lang === "en"
      ? "You are an analyst summarizing community/user comments about a place. From the provided list of comments, identify the main recurring themes (3-6), each with a short label, how common it is, and 1-2 representative quotes. Note overall sentiment if discernible. Be concise, use Markdown headings/lists. Only use the provided comments; do not invent. End with a one-line caveat that this reflects only the uploaded comments within the selected area."
      : "你是分析地點使用者意見的助理。請從提供的意見清單中,歸納出主要、反覆出現的主題(3-6 個),每個主題給簡短標題、常見程度,以及 1-2 句代表性原句引用;若可判斷請點出整體情緒傾向。務求精煉,使用 Markdown 標題與條列。只能根據提供的意見,不可杜撰。結尾以一句話提醒:本摘要僅反映選定範圍內所上傳的意見,不代表全體。";
    const head = lang === "en"
      ? ("Comments" + (data.region ? " near " + data.region : "") + " (" + comments.length + " items):\n\n")
      : ("以下為" + (data.region ? data.region + "附近" : "選定範圍內") + "的使用者意見(共 " + comments.length + " 則):\n\n");
    userContent = head + comments.map(function (c, i) { return (i + 1) + ". " + String(c).replace(/\n/g, " ").trim(); }).join("\n");
  } else {
    userContent = lang === "en"
      ? "Below are the real analysis figures (JSON) for a site. Write the site analysis report in English, following the required structure and rules. Keep Taiwanese place names and species names; you may keep scientific names as-is.\n\n```json\n" + JSON.stringify(data, null, 2) + "\n```"
      : "以下是某基地的分析真實數值(JSON)。請據此撰寫繁體中文基地分析報告:\n\n```json\n" + JSON.stringify(data, null, 2) + "\n```";
  }

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
        max_tokens: 4000, // 提高上限:報告含氣候+生態共七節,1500 不足會在生態段被截斷
        stream: true, // 串流:邊產生邊回傳,避免 Netlify 閒置逾時(504)
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
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
