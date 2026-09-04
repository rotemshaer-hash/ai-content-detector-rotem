// netlify/functions/hive-detect.mjs
//
// Optional, opt-in cloud AI-detection check. Unlike every other check in this
// app, this one sends the actual file to a third party (Hive) for a real
// trained-model classification — the frontend only calls this when the user
// explicitly asks for it, never automatically.
//
// Hive's API takes a public media_url, not raw bytes, so this stashes the
// file in Netlify Blobs just long enough for Hive to fetch it (via
// hive-serve.mjs, an unguessable capability URL), then deletes it.
//
// Confirmed live from Hive's own playground on 2026-09-04:
//   POST https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection
//   header: authorization: Bearer <key>
//   body: {"input":[{"media_url":"..."}],"processing_mode":"sync_with_fallback"}
// The exact shape of a successful response wasn't documented anywhere I could
// reach, so this parses defensively (searches the JSON tree for classification
// entries) and always returns Hive's raw response alongside the parsed guess,
// so a wrong guess is visible and fixable rather than silently swallowed.

import { getStore } from "@netlify/blobs";

const HIVE_ENDPOINT = "https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection";
const MAX_BYTES = 15 * 1024 * 1024; // keep well under Netlify's function payload ceiling

// Confirmed live against Hive's real response (2026-09-04): each item in
// output[].classes is {"class": "<name>", "value": <number>} — NOT "score"/
// "confidence" as commonly named elsewhere. The two that matter are the exact
// class names "ai_generated" and "not_ai_generated", which are a real
// probability pair (they sum to ~1). The same classes array also carries
// per-generator guesses (e.g. "sora") whose "value" is NOT a 0..1
// probability — those are informational only, never used for the main score.
function findClassificationScores(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) findClassificationScores(item, out);
    return;
  }
  const cls = node.class ?? node.label ?? node.name;
  const score = node.value ?? node.score ?? node.confidence ?? node.probability;
  if (typeof cls === "string" && typeof score === "number") {
    out.push({ class: cls, score });
  }
  for (const key of Object.keys(node)) findClassificationScores(node[key], out);
}

function summarize(hiveJson) {
  const found = [];
  findClassificationScores(hiveJson, found);

  // exact match first (the real, confirmed schema)
  let aiHit = found.find((f) => f.class === "ai_generated");
  let realHit = found.find((f) => f.class === "not_ai_generated");

  // fuzzy fallback only if Hive ever changes the exact names
  if (!aiHit) {
    const aiLike = found.filter((f) => /ai.?generat|synthetic|deepfake/i.test(f.class) && !/^not.?ai.?generat/i.test(f.class));
    if (aiLike.length) aiHit = aiLike.reduce((a, b) => (b.score > a.score ? b : a));
  }
  if (!realHit) {
    const realLike = found.filter((f) => /^(not.?ai.?generat|real|authentic)/i.test(f.class));
    if (realLike.length) realHit = realLike.reduce((a, b) => (b.score > a.score ? b : a));
  }

  if (!aiHit) return { parsed: false, allScores: found };

  // other per-generator-model classes Hive returned (e.g. "sora"), for context only
  const otherClasses = found.filter((f) => f.class !== "ai_generated" && f.class !== "not_ai_generated");

  return {
    parsed: true,
    aiClass: aiHit.class,
    aiScore: aiHit.score,
    realClass: realHit && realHit.class,
    realScore: realHit && realHit.score,
    otherClasses,
    allScores: found,
  };
}

export default async (req) => {
  const apiKey = process.env.HIVE_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "השירות לא מוגדר בצד השרת (חסר מפתח)" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const contentType = req.headers.get("content-type") || "application/octet-stream";
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) {
    return new Response(JSON.stringify({ error: "לא התקבל קובץ" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (buf.byteLength > MAX_BYTES) {
    return new Response(JSON.stringify({ error: "הקובץ גדול מדי לבדיקת הענן (מעל " + Math.round(MAX_BYTES/1024/1024) + "MB). זמין כרגע רק לקבצים קטנים-בינוניים." }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }

  const store = getStore("hive-uploads");
  const key = crypto.randomUUID();

  try {
    await store.set(key, buf, { metadata: { contentType } });

    const origin = new URL(req.url).origin;
    const mediaUrl = origin + "/.netlify/functions/hive-serve?key=" + key;

    const hiveResp = await fetch(HIVE_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: [{ media_url: mediaUrl }],
        processing_mode: "sync_with_fallback",
      }),
    });

    const hiveText = await hiveResp.text();
    let hiveJson;
    try {
      hiveJson = JSON.parse(hiveText);
    } catch {
      hiveJson = null;
    }

    if (!hiveResp.ok) {
      return new Response(JSON.stringify({
        error: "Hive החזיר שגיאה (סטטוס " + hiveResp.status + ")",
        hiveStatus: hiveResp.status,
        hiveRaw: hiveJson || hiveText,
      }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }

    const summary = summarize(hiveJson);
    return new Response(JSON.stringify({ ok: true, summary, hiveRaw: hiveJson }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  } finally {
    // best-effort cleanup; do not let a delete failure mask the real result
    try { await store.delete(key); } catch (_e) {}
  }
};
