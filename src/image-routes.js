/**
 * image-routes.js — 图像侧统一代理，挂进主 Worker。
 * 上游：Gitee AI (https://ai.gitee.com/v1)。密钥由前端以 Bearer 透传（维持现状，服务端不托管）。
 *
 * 路由（在主 worker.js 的 fetch 里优先匹配，未命中返回 null 交回主逻辑）：
 *   /img/v1/*    -> 代理到 https://ai.gitee.com/v1/<path>
 *   /img/dl?url= -> 下载代理（带 Range，剥 CSP/X-Frame，解决跨域下载）
 *
 * 用法（主 worker.js）：
 *   import { handleImageRequest } from "./image-routes.js";
 *   const img = await handleImageRequest(request, env);
 *   if (img) return img;
 */

const UPSTREAM = "https://ai.gitee.com/v1";

export async function handleImageRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/img/dl" || path === "/img/dl/") return handleDownload(request, url);
  if (path === "/img/r2/save") return handleR2Save(request, url, env);
  if (path === "/img/r2/get") return handleR2Get(request, url, env);
  if (path === "/img/gallery") return handleGallery(request, url, env);
  if (path.startsWith("/img/v1/")) return handleProxy(request, url);
  return null; // 不是图像路由，交回主 Worker
}

async function handleProxy(request, url) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  const rest = url.pathname.slice("/img/v1/".length);
  const target = new URL(`${UPSTREAM}/${rest}`);
  target.search = url.search;
  const headers = new Headers(request.headers);
  for (const k of ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"]) headers.delete(k);
  const init = { method: request.method, headers, redirect: "follow", cache: "no-store" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  const upstream = await fetch(target.toString(), init);
  const respHeaders = applyCors(stripCache(new Headers(upstream.headers)));
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
}

async function handleDownload(request, url) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  const target = url.searchParams.get("url") || "";
  if (!target || !(target.startsWith("https://") || target.startsWith("http://"))) {
    return new Response(JSON.stringify({ error: "Invalid or missing url param" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
  }
  const h = new Headers();
  const range = request.headers.get("Range");
  if (range) h.set("Range", range);
  const upstream = await fetch(target, { method: "GET", headers: h, redirect: "follow", cache: "no-store" });
  const respHeaders = stripCache(new Headers(upstream.headers));
  respHeaders.delete("Content-Security-Policy");
  respHeaders.delete("X-Frame-Options");
  applyCors(respHeaders);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: respHeaders });
}

// 与文本侧云同步同源鉴权: Authorization Bearer == env.CHAT_PASSWORD(未设则放行,便于本地)
function checkSync(request, env) {
  if (!env || !env.CHAT_PASSWORD) return true;
  const auth = request.headers.get("Authorization") || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim();
  const alt = request.headers.get("X-Sync-Token") || "";
  return tok === env.CHAT_PASSWORD || alt === env.CHAT_PASSWORD;
}
function genKey() {
  const r = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + "-" + Math.random().toString(16).slice(2));
  return "img/" + r;
}
function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}
async function handleR2Save(request, url, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (!env || !env.IMAGES_BUCKET) return jsonResp({ error: "R2 not bound (IMAGES_BUCKET)" }, 501);
  if (!checkSync(request, env)) return jsonResp({ error: "unauthorized" }, 401);
  const src = url.searchParams.get("url") || "";
  let body, ct;
  if (src) {
    if (!/^https?:\/\//.test(src)) return jsonResp({ error: "bad url" }, 400);
    const up = await fetch(src, { redirect: "follow", cache: "no-store" });
    if (!up.ok) return jsonResp({ error: "upstream " + up.status }, 502);
    body = await up.arrayBuffer();
    ct = up.headers.get("Content-Type") || "image/png";
  } else {
    body = await request.arrayBuffer();
    ct = request.headers.get("Content-Type") || "image/png";
  }
  const ext = ct.indexOf("jpeg") >= 0 ? ".jpg" : ct.indexOf("webp") >= 0 ? ".webp" : ".png";
  const key = genKey() + ext;
  await env.IMAGES_BUCKET.put(key, body, { httpMetadata: { contentType: ct } });
  return jsonResp({ key: key, url: "/img/r2/get?key=" + encodeURIComponent(key) }, 200);
}

function stripCache(h) {
  for (const k of ["Cache-Control", "ETag", "Last-Modified", "Expires", "Age", "Vary"]) h.delete(k);
  h.set("Cache-Control", "no-store, no-cache, must-revalidate");
  h.set("Pragma", "no-cache");
  return h;
}
const GALLERY_KEY = "gallery:default";
async function handleR2Get(request, url, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (!env || !env.IMAGES_BUCKET) return jsonResp({ error: "R2 not bound (IMAGES_BUCKET)" }, 501);
  const key = url.searchParams.get("key") || "";
  if (!key) return jsonResp({ error: "missing key" }, 400);
  const obj = await env.IMAGES_BUCKET.get(key);
  if (!obj) return jsonResp({ error: "not found" }, 404);
  const h = new Headers();
  h.set("Content-Type", (obj.httpMetadata && obj.httpMetadata.contentType) || "image/png");
  h.set("Cache-Control", "public, max-age=31536000, immutable");
  applyCors(h);
  return new Response(obj.body, { status: 200, headers: h });
}
async function handleGallery(request, url, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (!env || !env.IMAGES_SYNC) return jsonResp({ error: "KV not bound (IMAGES_SYNC)" }, 501);
  if (!checkSync(request, env)) return jsonResp({ error: "unauthorized" }, 401);
  if (request.method === "GET") {
    const raw = await env.IMAGES_SYNC.get(GALLERY_KEY);
    return jsonResp({ items: raw ? JSON.parse(raw) : [] }, 200);
  }
  let incoming = [];
  try { const b = await request.json(); incoming = Array.isArray(b) ? b : (b.items || []); } catch (e) {}
  const raw = await env.IMAGES_SYNC.get(GALLERY_KEY);
  const existing = raw ? JSON.parse(raw) : [];
  const merged = mergeGallery(existing, incoming);
  await env.IMAGES_SYNC.put(GALLERY_KEY, JSON.stringify(merged));
  return jsonResp({ items: merged }, 200);
}
function mergeGallery(a, b) {
  const map = new Map();
  for (const it of (a || [])) if (it && it.id) map.set(it.id, it);
  for (const it of (b || [])) {
    if (!it || !it.id) continue;
    const prev = map.get(it.id);
    if (!prev || (it.ts || 0) >= (prev.ts || 0)) map.set(it.id, it);
  }
  const arr = Array.from(map.values());
  arr.sort((x, y) => (y.ts || 0) - (x.ts || 0));
  return arr;
}
function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "86400" };
}
function applyCors(h) { for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v); return h; }