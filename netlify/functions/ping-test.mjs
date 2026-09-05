// Temporary diagnostic function, no dependencies at all — used to isolate
// whether the fetch-video 404 is caused by the ytdl-core bundling issue or
// something else entirely (e.g. a site-wide function-deploy problem).
// Safe to delete once fetch-video is confirmed working again.
export default async () => {
  return new Response(JSON.stringify({ ok: true, time: new Date().toISOString() }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
