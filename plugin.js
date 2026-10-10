// AniFeed: noticias de anime y calendario de emisión semanal, directo en la
// Home de Kino. Datos de MyAnimeList (RSS de noticias) y AniList (horarios de
// emisión, tendencias y próximos estrenos). No necesita tokens ni claves.
/// <reference path="./kino.d.ts" />

const VERSION = "0.1.0";

// ---------- utilidades ----------

// QuickJS no tiene fetch: todo pasa por kino.fetch. La respuesta ofrece
// .text() y .json() síncronos. Primera instrucción de toda función async:
// un await (regla de Kino 0.9.49-).

async function fetchTexto(url) {
  await null;
  const r = await kino.fetch(url);
  if (!r.ok) throw new Error("http " + r.status);
  return r.text();
}

async function fetchJson(url, options) {
  await null;
  const r = await kino.fetch(url, options);
  if (!r.ok) throw new Error("http " + r.status);
  return r.json();
}

// Zona horaria del usuario (Colombia por defecto).
function offsetUTC() {
  const v = parseInt(String(kino.config.get("utcOffset") || "").trim(), 10);
  return isNaN(v) ? -5 : v;
}

function limpiarHTML(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Hora local (HH:MM) de un momento en segundos Unix UTC.
function horaLocal(seg) {
  const t = new Date((seg + offsetUTC() * 3600) * 1000);
  return ("0" + t.getUTCHours()).slice(-2) + ":" + ("0" + t.getUTCMinutes()).slice(-2);
}

function fechaLocal(seg) {
  const t = new Date((seg + offsetUTC() * 3600) * 1000);
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return t.getUTCDate() + " " + meses[t.getUTCMonth()];
}

// Inicio (medianoche) del día local de hoy + desplazamiento, en segundos UTC.
function inicioDia(desplazamientoDias) {
  const ahora = new Date(Date.now() + offsetUTC() * 3600000);
  const medianoche = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate());
  return Math.floor(medianoche / 1000) + desplazamientoDias * 86400 - offsetUTC() * 3600;
}

// Día de semana local: 0 = lunes ... 6 = domingo.
function diaSemanaLocal() {
  const ahora = new Date(Date.now() + offsetUTC() * 3600000);
  return (ahora.getUTCDay() + 6) % 7;
}

// ---------- AniList: calendario, tendencias, próximos ----------

const QMEDIA = "id title { romaji english } description(asHtml: false) episodes format status averageScore genres coverImage { extraLarge } startDate { year }";

async function anilist(query, variables) {
  await null;
  const r = await fetchJson("https://graphql.anilist.co", {
    method: "POST",
    body: { json: { query: query, variables: variables } }
  });
  if (!r.data) throw new Error("sin datos");
  return r.data;
}

// Episodios que se emiten entre dos momentos (segundos Unix UTC).
async function emisiones(desdeSeg, hastaSeg) {
  await null;
  const d = await anilist(
    "query ($f: Int, $t: Int) { Page(perPage: 50) { airingSchedules(airingAt_greater: $f, airingAt_lesser: $t, sort: TIME) { airingAt episode media { " + QMEDIA + " } } } }",
    { f: desdeSeg, t: hastaSeg }
  );
  return (d.Page && d.Page.airingSchedules) || [];
}

// Lista de anime con un filtro libre (tendencias, próximos, etc.).
async function listaAnime(filtro, pagina) {
  await null;
  const d = await anilist(
    "query ($p: Int) { Page(page: $p, perPage: 30) { media(" + filtro + ", type: ANIME, isAdult: false) { " + QMEDIA + " } } }",
    { p: pagina }
  );
  return (d.Page && d.Page.media) || [];
}

function itemAnime(m) {
  const titulo = (m.title && (m.title.romaji || m.title.english)) || "Sin título";
  return {
    id: "al" + m.id,
    ref: "anime:" + m.id,
    title: titulo,
    kind: "movie",
    year: m.startDate && m.startDate.year ? m.startDate.year : undefined,
    poster: m.coverImage && m.coverImage.extraLarge ? m.coverImage.extraLarge : undefined,
    overview: limpiarHTML(m.description).slice(0, 900) || "Sin descripción.",
    genres: (m.genres || []).slice(0, 5),
    rating: m.averageScore ? Math.round(m.averageScore) / 10 : undefined
  };
}

// Un anime con su episodio y hora de emisión, con la info visible en la ficha.
function itemEmision(e) {
  const base = itemAnime(e.media);
  base.badges = ["Ep " + e.episode, horaLocal(e.airingAt)];
  base.overview = "Episodio " + e.episode + " se emite el " + fechaLocal(e.airingAt) +
    " a las " + horaLocal(e.airingAt) + " (UTC" + (offsetUTC() >= 0 ? "+" : "") + offsetUTC() + ").\n\n" +
    (base.overview || "");
  return base;
}

// ---------- Noticias de MyAnimeList (RSS) ----------

function haceCuanto(fechaRSS) {
  const t = Date.parse(fechaRSS);
  if (isNaN(t)) return "nuevo";
  const h = Math.max(0, Math.floor((Date.now() - t) / 3600000));
  if (h < 1) return "ahora";
  if (h < 24) return "hace " + h + " h";
  return "hace " + Math.floor(h / 24) + " d";
}

async function noticias() {
  await null;
  const xml = await fetchTexto("https://myanimelist.net/rss/news.xml");
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const bloque = m[1];
    const saca = (tag) => {
      const r = bloque.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
      return r ? r[1].trim() : "";
    };
    const titulo = limpiarHTML(saca("title"));
    if (!titulo) continue;
    const desc = limpiarHTML(saca("description"));
    const guid = saca("guid");
    const link = saca("link") || guid;
    let thumb = (bloque.match(/<media:thumbnail>([^<]+)<\/media:thumbnail>/) || [])[1] || "";
    if (!thumb) thumb = (bloque.match(/<media:thumbnail[^>]*url="([^"]+)"/) || [])[1] || "";
    items.push({
      id: "not-" + (guid.replace(/\D+/g, "") || String(items.length)),
      ref: "noticia:" + items.length,
      title: titulo,
      kind: "movie",
      poster: thumb.indexOf("https://") === 0 ? thumb : undefined,
      overview: (desc ? desc.slice(0, 900) : "Sin resumen.") + "\n\nFuente: MyAnimeList News",
      badges: [haceCuanto(saca("pubDate"))]
    });
  }
  return items;
}

// ---------- Categorías (las pestañas de días, como en la app de la captura) ----------

export async function categories() {
  await null;
  const dias = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
  const lista = [
    { id: "cat-hoy", title: "Hoy en emisión", ref: "emision:hoy" },
    { id: "cat-noticias", title: "Noticias de anime", ref: "noticias" },
    { id: "cat-tendencias", title: "En tendencia", ref: "tendencias" },
    { id: "cat-proximos", title: "Próximos estrenos", ref: "proximos" }
  ];
  for (let i = 0; i < 7; i++) {
    lista.push({ id: "cat-dia-" + i, title: dias[i], ref: "emision:" + i });
  }
  return lista;
}

// ---------- Home ----------

export async function home() {
  await null;
  const filas = [];
  try {
    const hoy = await emisiones(inicioDia(0), inicioDia(1) - 1);
    if (hoy.length) {
      filas.push({
        id: "hoy",
        title: "Hoy en emisión",
        genre: "anime",
        items: hoy.map(itemEmision).slice(0, 30),
        ref: "emision:hoy"
      });
    }
  } catch (e) { kino.log("home: emisiones falló:", e.code || e.message); }
  try {
    const n = await noticias();
    if (n.length) {
      filas.push({
        id: "noticias",
        title: "Noticias de anime",
        genre: "noticias",
        items: n.slice(0, 15),
        ref: "noticias"
      });
    }
  } catch (e) { kino.log("home: noticias falló:", e.code || e.message); }
  try {
    const t = await listaAnime("sort: TRENDING_DESC", 1);
    if (t.length) {
      filas.push({
        id: "tendencias",
        title: "En tendencia",
        genre: "anime",
        items: t.map(itemAnime).slice(0, 20),
        ref: "tendencias"
      });
    }
  } catch (e) { kino.log("home: tendencias falló:", e.code || e.message); }
  try {
    const p = await listaAnime("status: NOT_YET_RELEASED, sort: POPULARITY_DESC", 1);
    if (p.length) {
      filas.push({
        id: "proximos",
        title: "Próximos estrenos",
        genre: "anime",
        items: p.map(itemAnime).slice(0, 20),
        ref: "proximos"
      });
    }
  } catch (e) { kino.log("home: próximos falló:", e.code || e.message); }
  return filas;
}

// ---------- Ver más ----------

export async function browse(ref, cursor) {
  await null;
  if (ref === "noticias") {
    return { items: await noticias() };
  }
  if (ref === "tendencias" || ref === "proximos") {
    const pagina = parseInt(cursor || "1", 10) || 1;
    const filtro = ref === "tendencias"
      ? "sort: TRENDING_DESC"
      : "status: NOT_YET_RELEASED, sort: POPULARITY_DESC";
    const medios = await listaAnime(filtro, pagina);
    if (medios.length >= 30) {
      return { items: medios.map(itemAnime), next: String(pagina + 1) };
    }
    return { items: medios.map(itemAnime) };
  }
  if (ref === "emision:hoy") {
    const es = await emisiones(inicioDia(0), inicioDia(1) - 1);
    return { items: es.map(itemEmision) };
  }
  if (ref.indexOf("emision:") === 0) {
    const n = parseInt(ref.slice(9), 10);
    if (!isNaN(n) && n >= 0 && n < 7) {
      const hoy = diaSemanaLocal();
      const delta = (n - hoy + 7) % 7;
      const es = await emisiones(inicioDia(delta), inicioDia(delta + 1) - 1);
      return { items: es.map(itemEmision) };
    }
  }
  return { items: [] };
}

// ---------- Búsqueda ----------

export async function search(query) {
  await null;
  const d = await anilist(
    "query ($s: String) { Page(perPage: 20) { media(search: $s, type: ANIME, isAdult: false) { " + QMEDIA + " } } }",
    { s: query.q }
  );
  return ((d.Page && d.Page.media) || []).map(itemAnime);
}
