// netlify/functions/hive-serve.mjs
//
// Serves a single temporarily-stored file back over plain HTTP, by an
// unguessable key. Exists only because Hive's API takes a public media_url,
// not raw bytes — hive-detect.mjs stashes the user's file here just long
// enough for Hive's servers to fetch it, then deletes it immediately after.
// The key is a crypto-random UUID (122 bits), so this is a capability URL:
// unauthenticated by design, but not enumerable or guessable.

import { getStore } from "@netlify/blobs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async (req) => {
  const { searchParams } = new URL(req.url);
  const key = (searchParams.get("key") || "").trim();

  if (!UUID_RE.test(key)) {
    return new Response("Not found", { status: 404 });
  }

  const store = getStore("hive-uploads");
  const result = await store.getWithMetadata(key, { type: "arrayBuffer" });
  if (!result || !result.data) {
    return new Response("Not found", { status: 404 });
  }

  const contentType = (result.metadata && result.metadata.contentType) || "application/octet-stream";
  return new Response(result.data, {
    status: 200,
    headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
  });
};
