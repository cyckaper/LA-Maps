/* Cloudflare Pages Function: POST /api/analyze
 * 接收前端算好的「真實數值」,呼叫 Anthropic API 由 Claude 產生可讀的基地分析報告。
 * 金鑰存於環境變數 ANTHROPIC_API_KEY(於 Cloudflare 後台設定,前端不外露)。
 */

const MODEL = "claude-sonnet-4-6";

// 系統提示:嚴格限定只根據提供的數值解讀,引用法規,標示代理/不確定。
// 內含法規參考文字,供 Claude 正確引用(避免幻覺)。放在 system 並開啟 prompt caching。
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

5. 若提供 biodiversity 欄位,以其物種數、觀測筆數、受脅物種、分類群組成、代表性物種(top_species)與受脅物種名錄(threatened_list)評估生態現況。代表性物種點名 3-5 種即可;受脅物種僅挑選最具保育意義的 5-8 種點名說明,其餘以「等共 N 種」帶過,切勿逐一窮舉整份名錄。iNaturalist 為社群觀測,涵蓋度依地區而異,屬參考性指標而非完整生態調查,須標示此限制。
6. 若提供 climate 欄位(Open-Meteo ERA5 重分析之多年平均背景值,非即時天氣),請依年均溫、最熱月均溫、高溫日數、年降雨量、盛行風向、日均日射量,推導對基地設計的微氣候意涵:通風廊道與建物開窗方位(對應盛行風向)、遮蔭與植栽配置(對應高溫日數與日射量)、排水/滯洪與雨水花園(對應年降雨量)、以及氣候韌性。引用時須標明為「氣候背景值」。

報告結構(用簡短段落與條列,務求精煉好讀):
一、基地概述(位置、所在行政區、人口結構重點)
二、開放空間與綠地評估(可及性、綠覆、對照法規/準則,符合或不足)
三、氣候背景與微氣候(若有 climate 資料:氣溫、雨量、盛行風向、日射量及其設計意涵;無資料則略過)
四、熱環境與健康研判(高溫脆弱度與成因、敏感族群,結合氣候背景與綠覆綜合研判,標示為研判)
五、生態與生物多樣性(若有 biodiversity 資料:物種豐富度、分類群、受脅物種,標示 iNaturalist 涵蓋度限制;無資料則略過)
六、規劃建議(2-4 點,具體、可行,扣回前述數據與法規)
七、資料與限制說明(資料來源、代理指標、不確定性)

語氣:專業、客觀、精準。全文約 600-1000 字(英文版約 400-700 words);務必完整寫到「資料與限制說明」一節作結,不可中途停筆。`;

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

export async function onRequestOptions() {
  return json({ ok: true });
}

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "伺服器尚未設定 ANTHROPIC_API_KEY(請於 Cloudflare 後台設定環境變數)。" }, 500);
  }
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ error: "請求格式錯誤(需為 JSON)。" }, 400);
  }

  const lang = data && data.lang === "en" ? "en" : "zh";
  const userContent = lang === "en"
    ? "Below are the real analysis figures (JSON) for a site. Write the site analysis report in English, following the required structure and rules. Keep Taiwanese place names and species names; you may keep scientific names as-is.\n\n```json\n" + JSON.stringify(data, null, 2) + "\n```"
    : "以下是某基地的分析真實數值(JSON)。請據此撰寫繁體中文基地分析報告:\n\n```json\n" + JSON.stringify(data, null, 2) + "\n```";

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 6000,
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }
        ],
        messages: [{ role: "user", content: userContent }]
      })
    });

    const out = await resp.json();
    if (!resp.ok) {
      return json({ error: (out && out.error && out.error.message) || "AI 服務回應錯誤。" }, resp.status);
    }

    // 非串流:由 Cloudflare 在伺服器端一次完整收齊 Anthropic 回覆,再一次回傳前端。
    // 改用非串流(取代先前 SSE)是因為長時間串流連線在行動裝置/Wi-Fi 上易中途斷線,
    // 導致前端把不完整內容當成「已完成」而出現截斷。短連線一次傳完可避免此問題。
    let text = (out.content || []).map((b) => b.text || "").join("").trim();
    if (out.stop_reason === "max_tokens") {
      text += "\n\n---\n\n> ⚠️ 報告因長度上限被截斷,以上內容未完整。請縮小基地範圍或重新產生。";
    }
    // 回傳 text/plain;前端以 r.body.getReader() 讀取仍完全相容(一次性 body 也能讀完)。
    return new Response(text, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-cache"
      }
    });
  } catch (e) {
    return json({ error: "呼叫 AI 服務失敗:" + (e && e.message ? e.message : String(e)) }, 502);
  }
}
