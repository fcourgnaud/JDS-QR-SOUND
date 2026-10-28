/* Tribes Showdown — service worker (app hors ligne)
   La version vient de index.html (sw.js?v=v88) : il n'y a RIEN à modifier ici quand tu publies.
   - index.html : réseau d'abord (3 s max), sinon la copie sur le téléphone → une nouvelle version arrive au lancement suivant, jamais en pleine partie
   - sons/ : copie sur le téléphone d'abord (démarrage instantané), puis vérification discrète en ligne ; un MP3 remplacé sur GitHub est mis à jour pour la partie suivante
   - polices (Google Fonts) et lecteur de QR (jsQR.js) : gardés sur le téléphone */
const V = new URL(self.location).searchParams.get("v") || "dev";
const APP = "ts-app-" + V, SONS = "ts-sons", EXT = "ts-ext";
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png", "jsQR.js"];
const EXT_URLS = [
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&family=Bungee&family=Chakra+Petch:wght@500;700&family=IBM+Plex+Mono:wght@400;600&display=swap"
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(APP);
    await c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })));
    const x = await caches.open(EXT);
    await Promise.all(EXT_URLS.map(async u => { try { if (!(await x.match(u))) { const r = await fetch(u, { mode: "cors" }); if (r.ok) await x.put(u, r); } } catch (err) {} }));
    await self.skipWaiting();   /* la page est déjà la nouvelle version (index.html vient du réseau) : on peut prendre la main tout de suite */
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("ts-app-") && k !== APP) await caches.delete(k);
    await self.clients.claim();
  })());
});

const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("lent")), ms))]);
const sansReseau = () => new Response("", { status: 404, statusText: "hors ligne" });
/* Safari refuse une page servie par le service worker si la réponse a suivi une redirection */
const propre = async r => r.redirected ? new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers: r.headers }) : r;
/* garde le service worker éveillé jusqu'à la fin d'un travail lancé plus tard */
const garder = e => { let fin; e.waitUntil(new Promise(r => fin = r)); return fin; };

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  /* la page elle-même */
  if (req.mode === "navigate" || (url.origin === location.origin && /\/(index\.html)?$/.test(url.pathname))) {
    e.respondWith((async () => {
      const c = await caches.open(APP);
      try {
        const r = await propre(await timeout(fetch(req.url, { cache: "no-cache", credentials: "same-origin" }), 3000));
        if (r.ok) { await c.put("./", r.clone()); return r; }
      } catch (err) {}
      return (await c.match("./")) || (await c.match(req, { ignoreSearch: true })) || sansReseau();
    })());
    return;
  }

  /* les sons */
  if (url.origin === location.origin && url.pathname.includes("/sons/")) {
    const fin = garder(e);
    e.respondWith((async () => {
      const c = await caches.open(SONS);
      const key = url.origin + url.pathname;            /* sans le ?… éventuel */
      const hit = await c.match(key);
      const net = fetch(key, { cache: "no-cache" }).then(async r => {
        const tag = x => x && (x.headers.get("etag") || x.headers.get("last-modified"));
        if (r.ok) { if (!hit || !tag(r) || tag(r) !== tag(hit)) await c.put(key, r.clone()); }   /* on ne réécrit que si le fichier a changé */
        else if (r.status === 404) await c.delete(key);  /* fichier retiré du dépôt */
        return r;
      });
      net.then(fin, fin);
      if (hit) return hit;
      try { return await net; } catch (err) { return sansReseau(); }
    })());
    return;
  }

  /* liste des fichiers du dépôt (API GitHub) : en ligne d'abord, sinon la dernière connue ; sert aussi à ranger le cache des sons */
  if (url.hostname === "api.github.com" && url.pathname.includes("/git/trees/")) {
    const fin = garder(e);
    e.respondWith((async () => {
      const c = await caches.open(EXT);
      try {
        const r = await timeout(fetch(req), 5000);
        if (r.ok) { await c.put(req.url, r.clone()); rangerSons(r.clone()).catch(() => {}).then(fin); } else fin();
        return r;
      } catch (err) { fin(); return (await c.match(req.url)) || sansReseau(); }
    })());
    return;
  }

  /* polices */
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith((async () => {
      const c = await caches.open(EXT);
      const hit = await c.match(req.url);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok || r.type === "opaque") await c.put(req.url, r.clone()); return r; }
      catch (err) { return sansReseau(); }
    })());
    return;
  }

  /* le reste (icônes, manifeste…) : téléphone d'abord */
  if (url.origin === location.origin) {
    e.respondWith((async () => (await caches.match(req, { ignoreSearch: true })) || fetch(req).catch(sansReseau))());
  }
});

/* efface du téléphone les sons qui ne sont plus dans le dépôt */
async function rangerSons(resp) {
  const j = await resp.json(); if (!j || !Array.isArray(j.tree)) return;
  const nf = s => s.normalize("NFC").toLowerCase();
  const keep = new Set(j.tree.filter(x => x.type === "blob" && /^sons\//.test(x.path)).map(x => nf(x.path)));
  if (!keep.size) return;
  const base = new URL("./", self.registration.scope).pathname;
  const c = await caches.open(SONS);
  for (const r of await c.keys()) {
    let p = decodeURIComponent(new URL(r.url).pathname);
    if (p.startsWith(base)) p = p.slice(base.length);
    if (!keep.has(nf(p))) await c.delete(r);
  }
}

/* la page demande l'état du téléchargement */
self.addEventListener("message", e => {
  if (e.data === "etat") e.waitUntil((async () => {
    const c = await caches.open(SONS);
    const n = (await c.keys()).filter(r => /\.mp3$/i.test(new URL(r.url).pathname)).length;
    e.source && e.source.postMessage({ type: "etat", mp3: n, version: V });
  })());
});
