// Vienna Webdesigns TikTok autoposter.
// Generator (GitHub Actions) -> /api/ingest -> pending -> human review in the dashboard
// -> scheduled -> cron posts via Direct Post -> processing -> posted.
// Nothing is posted without an explicit "Einplanen" in the dashboard (TikTok content sharing rules).

const API = "https://open.tiktokapis.com/v2";
const SESSION_COOKIE = "ap_session";
const SESSION_DAYS = 14;
const PRIVACY = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];

const now = () => Date.now();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

// ---------- crypto ----------

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmacKey(env) {
  return crypto.subtle.importKey("raw", enc.encode("session:" + env.APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function aesKey(env) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode("tokens:" + env.APP_SECRET));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(env, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(JSON.stringify(obj)));
  return b64(iv) + "." + b64(ct);
}
async function unseal(env, s) {
  const [iv, ct] = s.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env), unb64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
// Constant-time compare for shared secrets.
async function safeEqual(a, b) {
  if (!a || !b) return false;
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// ---------- session ----------

async function makeSession(env) {
  const exp = now() + SESSION_DAYS * 86400e3;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(String(exp)));
  return `${exp}.${b64(sig)}`;
}
async function isAuthed(req, env) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || Number(exp) < now()) return false;
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(env), unb64(sig), enc.encode(exp));
  } catch {
    return false;
  }
}
const cookie = (value, maxAge) => `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

// The main site only starts an autoposter OAuth flow with a ticket signed by AUTOPOSTER_SECRET,
// so nobody but a logged-in dashboard user can attach their TikTok account to this worker.
async function connectUrl(env) {
  const exp = String(now() + 15 * 60e3);
  const key = await crypto.subtle.importKey("raw", enc.encode(env.AUTOPOSTER_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("connect:" + exp));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${env.CONNECT_URL}&ticket=${exp}.${hex}`;
}

// ---------- TikTok ----------

async function tokenRequest(env, params) {
  const r = await fetch(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, ...params }),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error_description || j.error || `token ${r.status}`);
  return j;
}

async function saveTokens(env, t) {
  const token = await seal(env, { access_token: t.access_token, refresh_token: t.refresh_token });
  await env.DB.prepare(
    `INSERT INTO account (id, open_id, scope, token, access_expires_at, refresh_expires_at, updated_at)
     VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(id) DO UPDATE SET open_id=?1, scope=?2, token=?3, access_expires_at=?4, refresh_expires_at=?5, updated_at=?6`,
  )
    .bind(t.open_id, t.scope, token, now() + t.expires_in * 1000, now() + t.refresh_expires_in * 1000, now())
    .run();
}

// Returns a valid access token, refreshing it when it expires within 5 minutes.
async function accessToken(env) {
  const row = await env.DB.prepare("SELECT * FROM account WHERE id = 1").first();
  if (!row) throw new Error("TikTok ist nicht verbunden");
  const t = await unseal(env, row.token);
  if (row.access_expires_at - now() > 5 * 60e3) return t.access_token;
  if (row.refresh_expires_at < now()) throw new Error("TikTok-Verbindung abgelaufen, bitte neu verbinden");
  const fresh = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: t.refresh_token });
  await saveTokens(env, fresh);
  return fresh.access_token;
}

async function tiktok(env, path, { method = "POST", body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${await accessToken(env)}`, "content-type": "application/json; charset=UTF-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error && j.error.code !== "ok") throw new Error(`${j.error.code}: ${j.error.message}`);
  return j.data;
}

// ---------- posting ----------

async function setVideo(env, id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = ?${i + 1}`).join(", ");
  await env.DB.prepare(`UPDATE videos SET ${sets}, updated_at = ?${keys.length + 1} WHERE id = ?${keys.length + 2}`)
    .bind(...keys.map((k) => fields[k]), now(), id)
    .run();
}

async function postVideo(env, v) {
  const creator = await tiktok(env, "/post/publish/creator_info/query/");
  if (!creator.privacy_level_options.includes(v.privacy_level)) {
    throw new Error(`Privatsphäre ${v.privacy_level} ist für dieses Konto nicht erlaubt`);
  }
  if (v.duration && creator.max_video_post_duration_sec && v.duration > creator.max_video_post_duration_sec) {
    throw new Error(`Video ist länger als ${creator.max_video_post_duration_sec}s`);
  }
  const bytes = await env.VIDEOS.get(v.file_key, "arrayBuffer");
  if (!bytes) throw new Error("Videodatei fehlt im Speicher");

  const init = await tiktok(env, "/post/publish/video/init/", {
    body: {
      post_info: {
        title: v.title || "",
        privacy_level: v.privacy_level,
        disable_comment: !!v.disable_comment || creator.comment_disabled,
        disable_duet: !!v.disable_duet || creator.duet_disabled,
        disable_stitch: !!v.disable_stitch || creator.stitch_disabled,
        brand_organic_toggle: !!v.brand_organic,
        brand_content_toggle: !!v.brand_content,
        // Every video from this pipeline is AI-generated and must carry TikTok's AIGC label.
        is_aigc: true,
      },
      source_info: { source: "FILE_UPLOAD", video_size: bytes.byteLength, chunk_size: bytes.byteLength, total_chunk_count: 1 },
    },
  });
  const put = await fetch(init.upload_url, {
    method: "PUT",
    headers: { "content-type": "video/mp4", "content-range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` },
    body: bytes,
  });
  if (!put.ok) throw new Error(`Upload zu TikTok fehlgeschlagen (${put.status})`);
  await setVideo(env, v.id, { status: "processing", publish_id: init.publish_id, error: null });
}

async function runCron(env) {
  // Finish posts that TikTok is still processing.
  const processing = await env.DB.prepare("SELECT * FROM videos WHERE status = 'processing' LIMIT 10").all();
  for (const v of processing.results) {
    try {
      const s = await tiktok(env, "/post/publish/status/fetch/", { body: { publish_id: v.publish_id } });
      if (s.status === "PUBLISH_COMPLETE") {
        await setVideo(env, v.id, { status: "posted", post_id: (s.publicaly_available_post_id || [])[0] ?? null });
        await env.VIDEOS.delete(v.file_key);
      } else if (s.status === "FAILED") {
        await setVideo(env, v.id, { status: "failed", error: s.fail_reason || "TikTok meldet FAILED" });
      }
    } catch (e) {
      await setVideo(env, v.id, { error: String(e.message || e) });
    }
  }

  // Post what is due. Two per run keeps us far below TikTok's per-account posting limits.
  const due = await env.DB.prepare("SELECT * FROM videos WHERE status = 'scheduled' AND scheduled_at <= ?1 ORDER BY scheduled_at LIMIT 2")
    .bind(now())
    .all();
  for (const v of due.results) {
    // Claim the row first so an overlapping cron run cannot post it twice.
    const claim = await env.DB.prepare("UPDATE videos SET status = 'posting', updated_at = ?1 WHERE id = ?2 AND status = 'scheduled'").bind(now(), v.id).run();
    if (!claim.meta.changes) continue;
    try {
      await postVideo(env, v);
    } catch (e) {
      await setVideo(env, v.id, { status: "failed", error: String(e.message || e) });
    }
  }
}

// ---------- HTTP ----------

async function handleApi(req, env, url) {
  const path = url.pathname;
  const method = req.method;

  // Machine endpoints, authenticated with the shared AUTOPOSTER_SECRET.
  if (path === "/api/ingest" && method === "POST") {
    if (!(await safeEqual(req.headers.get("x-autoposter-secret"), env.AUTOPOSTER_SECRET))) return json({ error: "forbidden" }, 403);
    const meta = JSON.parse(decodeURIComponent(req.headers.get("x-meta") || "%7B%7D"));
    const body = await req.arrayBuffer();
    if (!body.byteLength) return json({ error: "empty body" }, 400);
    const id = crypto.randomUUID();
    const key = `videos/${id}.mp4`;
    if (body.byteLength > 24e6) return json({ error: "Video zu groß (max. 24 MB)" }, 413);
    await env.VIDEOS.put(key, body);
    await env.DB.prepare(
      `INSERT INTO videos (id, file_key, size, duration, topic, caption, vars, title, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, 'pending', ?8, ?8)`,
    )
      .bind(id, key, body.byteLength, meta.duration ?? null, meta.topic ?? null, meta.caption ?? "", JSON.stringify(meta.vars ?? {}), now())
      .run();
    return json({ id });
  }
  // Licensed audio stays out of the public repo; the generator downloads it from KV at render time.
  const asset = path.match(/^\/api\/asset\/((?:music|sfx)\/[a-z0-9-]+\.(?:mp3|wav))$/);
  if (asset && method === "GET") {
    if (!(await safeEqual(req.headers.get("x-autoposter-secret"), env.AUTOPOSTER_SECRET))) return json({ error: "forbidden" }, 403);
    const file = await env.VIDEOS.get(`assets/${asset[1]}`, "arrayBuffer");
    return file ? new Response(file) : json({ error: "not found" }, 404);
  }
  if (path === "/api/connect" && method === "POST") {
    if (!(await safeEqual(req.headers.get("x-autoposter-secret"), env.AUTOPOSTER_SECRET))) return json({ error: "forbidden" }, 403);
    await saveTokens(env, await req.json());
    return json({ ok: true });
  }

  if (path === "/api/login" && method === "POST") {
    const { password } = await req.json().catch(() => ({}));
    if (!(await safeEqual(password, env.DASHBOARD_PASSWORD))) return json({ error: "Falsches Passwort" }, 401);
    return json({ ok: true }, 200, { "set-cookie": cookie(await makeSession(env), SESSION_DAYS * 86400) });
  }
  if (path === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });

  if (!(await isAuthed(req, env))) return json({ error: "unauthorized" }, 401);

  if (path === "/api/state" && method === "GET") {
    const account = await env.DB.prepare("SELECT open_id, scope, refresh_expires_at FROM account WHERE id = 1").first();
    let creator = null, creatorError = null;
    if (account) {
      try {
        creator = await tiktok(env, "/post/publish/creator_info/query/");
      } catch (e) {
        creatorError = String(e.message || e);
      }
    }
    const videos = await env.DB.prepare(
      "SELECT id, size, duration, topic, caption, title, status, privacy_level, scheduled_at, post_id, error, created_at FROM videos WHERE status != 'rejected' ORDER BY created_at DESC LIMIT 60",
    ).all();
    return json({ connectUrl: await connectUrl(env), account, creator, creatorError, videos: videos.results });
  }

  const m = path.match(/^\/api\/videos\/([0-9a-f-]{36})(\/file|\/schedule|\/reject|\/unschedule)?$/);
  if (m) {
    const [, id, action] = m;
    const v = await env.DB.prepare("SELECT * FROM videos WHERE id = ?1").bind(id).first();
    if (!v) return json({ error: "not found" }, 404);

    if (action === "/file" && method === "GET") {
      const file = await env.VIDEOS.get(v.file_key, "arrayBuffer");
      if (!file) return json({ error: "file missing" }, 404);
      return new Response(file, { headers: { "content-type": "video/mp4", "cache-control": "private, max-age=3600" } });
    }
    if (action === "/schedule" && method === "POST") {
      if (!["pending", "scheduled", "failed"].includes(v.status)) return json({ error: `Status ${v.status} kann nicht eingeplant werden` }, 409);
      const b = await req.json();
      if (!PRIVACY.includes(b.privacy_level)) return json({ error: "Bitte Privatsphäre wählen" }, 400);
      if (b.brand_content && b.privacy_level === "SELF_ONLY") return json({ error: "Branded Content kann nicht privat sein" }, 400);
      const at = Number(b.scheduled_at);
      if (!at || at < now() - 60e3) return json({ error: "Zeitpunkt liegt in der Vergangenheit" }, 400);
      await setVideo(env, id, {
        status: "scheduled",
        title: String(b.title || "").slice(0, 2200),
        privacy_level: b.privacy_level,
        disable_comment: b.allow_comment ? 0 : 1,
        disable_duet: b.allow_duet ? 0 : 1,
        disable_stitch: b.allow_stitch ? 0 : 1,
        brand_organic: b.brand_organic ? 1 : 0,
        brand_content: b.brand_content ? 1 : 0,
        scheduled_at: at,
        error: null,
      });
      return json({ ok: true });
    }
    if (action === "/unschedule" && method === "POST") {
      if (v.status !== "scheduled") return json({ error: "Nicht eingeplant" }, 409);
      await setVideo(env, id, { status: "pending", scheduled_at: null });
      return json({ ok: true });
    }
    if (action === "/reject" && method === "POST") {
      if (!["pending", "failed"].includes(v.status)) return json({ error: `Status ${v.status} kann nicht verworfen werden` }, 409);
      await env.VIDEOS.delete(v.file_key);
      await setVideo(env, id, { status: "rejected" });
      return json({ ok: true });
    }
  }

  if (path === "/api/disconnect" && method === "POST") {
    const row = await env.DB.prepare("SELECT token FROM account WHERE id = 1").first();
    if (row) {
      const t = await unseal(env, row.token).catch(() => null);
      if (t) {
        await fetch(`${API}/oauth/revoke/`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, token: t.access_token }),
        }).catch(() => {});
      }
      await env.DB.prepare("DELETE FROM account WHERE id = 1").run();
    }
    return json({ ok: true });
  }

  if (path === "/api/run-now" && method === "POST") {
    await runCron(env);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url);
      } catch (e) {
        console.error(e);
        return json({ error: String(e.message || e) }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};
