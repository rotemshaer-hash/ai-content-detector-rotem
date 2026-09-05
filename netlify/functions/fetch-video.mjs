// netlify/functions/fetch-video.mjs
//
// Server-side proxy that fetches a video from a social-media link and streams
// the raw file bytes back to the browser. This exists because YouTube,
// TikTok, Instagram, Facebook and Twitter/X all block direct cross-origin
// fetches from a browser (CORS) — there is no client-side fix for that, the
// fetch has to happen from a server. This function is that server.
//
// Called by index.html as: /.netlify/functions/fetch-video?url=<encoded link>
// (bundled with node_bundler = "nft", see netlify.toml — esbuild + external_node_modules
// wasn't enough to fix the 404, this function needs a full content change to force Netlify
// to rebuild it rather than reuse a stale cached bundle from before that fix)

import ytdl from "@distube/ytdl-core";
import { Readable } from "node:stream";
import dns from "node:dns/promises";
import net from "node:net";

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// ---------- SSRF guard ----------
// This function fetches whatever URL it's told to and streams the response
// straight back to the caller. Without a check like this, the "unrecognized
// platform" fallback below turns it into an open proxy: anyone on the
// internet (no auth on this endpoint) could point it at internal services,
// cloud metadata endpoints, or localhost, and read the response through us.
// Every outbound fetch of a URL that traces back to user input or a
// third-party API response goes through this first.
function isPrivateOrReservedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata (169.254.169.254)
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    return false;
  }
  if (type === 6) {
    const low = ip.toLowerCase();
    if (low === "::1") return true; // loopback
    if (low.startsWith("fe80:") || low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true; // link-local
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique local
    if (low.startsWith("::ffff:")) return isPrivateOrReservedIp(low.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // not a parseable IP literal at all — treat as unsafe
}

async function assertPublicHttpUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("קישור לא תקין");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("מותרים רק קישורי http/https");
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 [] brackets
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("קישור לא מורשה");
  }
  // literal IP in the URL itself
  if (net.isIP(host) && isPrivateOrReservedIp(host)) {
    throw new Error("קישור לא מורשה");
  }
  // resolve the hostname and block it if ANY resolved address is private/reserved —
  // closes the DNS-rebinding gap where the hostname itself looks public
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("לא ניתן היה לפענח את הכתובת");
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new Error("קישור לא מורשה");
  }
  return u;
}

function safeName(raw, fallback) {
  let s = (raw || fallback || "video").toString().trim();
  s = s.replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim();
  return (s || fallback || "video").slice(0, 80);
}

async function fetchText(url, extraHeaders) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...extraHeaders },
  });
  if (!r.ok) throw new Error("http " + r.status + " בגישה ל-" + url);
  return await r.text();
}

// ---------- TikTok ----------
async function resolveTikTok(url) {
  const api = "https://www.tikwm.com/api/?url=" + encodeURIComponent(url) + "&hd=1";
  const r = await fetch(api, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("tikwm http " + r.status);
  const j = await r.json();
  const d = j && j.data;
  const play = d && (d.hdplay || d.play);
  if (!play) throw new Error("לא נמצא קישור וידאו בטיקטוק (יתכן שהפוסט פרטי או הוסר)");
  return {
    directUrl: play,
    filename: safeName(d.title, "tiktok") + ".mp4",
    referer: "https://www.tiktok.com/",
  };
}

// ---------- Twitter / X ----------
async function resolveTwitter(url) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/$/, "");
  const api = "https://api.vxtwitter.com" + path;
  const r = await fetch(api, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("vxtwitter http " + r.status);
  const j = await r.json();
  const media =
    j &&
    j.media_extended &&
    j.media_extended.find((m) => m.type === "video" || m.type === "gif");
  if (!media || !media.url) throw new Error("לא נמצא סרטון בציוץ הזה");
  return { directUrl: media.url, filename: safeName(j.text, "twitter") + ".mp4" };
}

// ---------- Instagram / Facebook (best-effort, public posts only) ----------
async function resolveByOgVideo(url, platformLabel, referer) {
  const html = await fetchText(url, referer ? { Referer: referer } : undefined);
  const m =
    html.match(/<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/"video_url":"([^"]+)"/);
  if (!m) {
    throw new Error(
      "לא נמצא קישור וידאו ישיר ב-" + platformLabel + " (הפוסט כנראה פרטי או דורש התחברות)"
    );
  }
  const direct = m[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  let title = platformLabel;
  const tm = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (tm) title = tm[1];
  return { directUrl: direct, filename: safeName(title, platformLabel) + ".mp4", referer: referer || url };
}

// ---------- dispatch by platform ----------
async function resolveVideoUrl(targetUrl) {
  let u;
  try {
    u = new URL(targetUrl);
  } catch {
    throw new Error("קישור לא תקין");
  }
  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");

  if (host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com")) {
    if (!ytdl.validateURL(targetUrl)) throw new Error("קישור יוטיוב לא תקין");
    const info = await ytdl.getInfo(targetUrl);
    let format = ytdl.chooseFormat(info.formats, { quality: "18" }); // 360p progressive mp4, small & fast
    if (!format) format = ytdl.chooseFormat(info.formats, { filter: "audioandvideo", quality: "highest" });
    if (!format) throw new Error("לא נמצא פורמט וידאו מתאים לסרטון הזה");
    const title = safeName(info.videoDetails && info.videoDetails.title, "youtube");
    return { kind: "ytdl", info, format, filename: title + ".mp4" };
  }

  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
    return await resolveTikTok(targetUrl);
  }

  if (host === "twitter.com" || host === "x.com") {
    return await resolveTwitter(targetUrl);
  }

  if (host === "instagram.com") {
    return await resolveByOgVideo(targetUrl, "אינסטגרם", "https://www.instagram.com/");
  }

  if (host === "facebook.com" || host === "fb.watch" || host.endsWith(".facebook.com")) {
    return await resolveByOgVideo(targetUrl, "פייסבוק", "https://www.facebook.com/");
  }

  // Fallback: not a platform we special-cased — try it as a direct file link.
  return { directUrl: targetUrl, filename: safeName(u.pathname.split("/").pop(), "file") };
}

export default async (req) => {
  const { searchParams } = new URL(req.url);
  const targetUrl = (searchParams.get("url") || "").trim();
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: "חסר קישור" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  try {
    const resolved = await resolveVideoUrl(targetUrl);

    if (resolved.kind === "ytdl") {
      const nodeStream = ytdl.downloadFromInfo(resolved.info, { format: resolved.format });
      const webStream = Readable.toWeb(nodeStream);
      return new Response(webStream, {
        status: 200,
        headers: {
          "Content-Type": (resolved.format.mimeType || "video/mp4").split(";")[0],
          "Content-Disposition": `attachment; filename="${resolved.filename}"`,
          ...cors,
        },
      });
    }

    const safeUrl = await assertPublicHttpUrl(resolved.directUrl);
    const upstream = await fetch(safeUrl, {
      redirect: "error", // a redirect to a private address would bypass the check above
      headers: {
        "User-Agent": UA,
        ...(resolved.referer ? { Referer: resolved.referer } : {}),
      },
    });
    if (!upstream.ok || !upstream.body) {
      throw new Error("השרת המקורי סירב לספק את הקובץ (סטטוס " + upstream.status + ")");
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "video/mp4",
        "Content-Disposition": `attachment; filename="${resolved.filename}"`,
        ...cors,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err && err.message) || err) }), {
      status: 502,
      headers: { "content-type": "application/json", ...cors },
    });
  }
};
