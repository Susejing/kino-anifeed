// AniFeed: noticias de anime y calendario de emisión semanal, directo en la
// Home de Kino. Datos de MyAnimeList (RSS de noticias) y AniList (horarios de
// emisión, tendencias y próximos estrenos). No necesita tokens ni claves.
/// <reference path="./kino.d.ts" />

const VERSION = "0.1.2";

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

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function fechaLocal(seg) {
  const t = new Date((seg + offsetUTC() * 3600) * 1000);
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return DIAS[t.getUTCDay()] + " " + t.getUTCDate() + " " + meses[t.getUTCMonth()];
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
    overview: "Sinopsis:\n" + (limpiarHTML(m.description).slice(0, 900) || "Sin descripción."),
    genres: (m.genres || []).slice(0, 5),
    rating: m.averageScore ? Math.round(m.averageScore) / 10 : undefined
  };
}

// Un anime con su episodio y hora de emisión, con la info visible en la ficha.
function itemEmision(e) {
  const base = itemAnime(e.media);
  base.badges = ["Ep " + e.episode, horaLocal(e.airingAt)];
  base.overview = "📺 Episodio " + e.episode + " se emite el " + fechaLocal(e.airingAt) +
    " a las " + horaLocal(e.airingAt) + " (UTC" + (offsetUTC() >= 0 ? "+" : "") + offsetUTC() + ").\n\n" +
    base.overview;
  return base;
}

// ---------- Noticias de MyAnimeList (RSS), traducidas al español ----------

// Traducción gratuita (Google, endpoint público). Con caché en storage para
// no repetir ni saturar: cada texto se traduce una vez y queda guardado.
function hashCorto(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) & 0x7fffffff;
  return h.toString(36);
}

async function traducir(texto) {
  await null;
  if (!texto) return "";
  const clave = "tr:" + hashCorto(texto);
  const cache = kino.storage.get(clave);
  if (cache) return cache;
  const r = await fetchJson("https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t&q=" + encodeURIComponent(texto.slice(0, 500)), {});
  const partes = (r && r[0]) || [];
  let salida = "";
  for (let i = 0; i < partes.length; i++) {
    if (partes[i] && partes[i][0]) salida += partes[i][0];
  }
  if (!salida) throw new Error("sin traducción");
  try { kino.storage.set(clave, salida, 2000000000); } catch (e2) { /* cache lleno */ }
  return salida;
}

// Traduce y si algo falla devuelve el original (nunca rompe la fila).
async function traducirSeguro(texto) {
  await null;
  try { return await traducir(texto); } catch (e) { return texto; }
}

// Traduce textos largos por trozos (500 caracteres) en paralelo y los une.
async function traducirLargo(texto) {
  await null;
  const partes = [];
  let resto = String(texto || "");
  while (resto.length > 0) {
    let trozo = resto.slice(0, 500);
    resto = resto.slice(500);
    if (resto.length > 0 && resto[0] !== " ") {
      const corte = trozo.lastIndexOf(" ");
      if (corte > 200) { resto = trozo.slice(corte + 1) + resto; trozo = trozo.slice(0, corte); }
    }
    partes.push(trozo);
  }
  const traducidos = await Promise.all(partes.map((p) => traducirSeguro(p)));
  return traducidos.join(" ");
}

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
  const brutas = [];
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
    brutas.push({ titulo: titulo, desc: desc, guid: guid, link: link, thumb: thumb, fecha: saca("pubDate") });
  }
  // Título y resumen traducidos en paralelo (la caché evita repetir).
  await Promise.all(brutas.map(async (b) => {
    b.tituloEs = await traducirSeguro(b.titulo);
    b.descEs = b.desc ? await traducirSeguro(b.desc.slice(0, 450)) : "";
  }));
  const items = [];
  for (let i = 0; i < brutas.length; i++) {
    const b = brutas[i];
    const traducida = b.tituloEs !== b.titulo;
    const nid = b.guid.replace(/\D+/g, "") || String(i);
    // El resumen ya traducido se guarda para el respaldo del artículo completo.
    try { kino.storage.set("notresumen-es:" + nid, b.descEs || b.desc || "", 172800000); } catch (e2) { /* cache llena */ }
    items.push({
      id: "not-" + nid,
      ref: "noticia:" + nid,
      title: b.tituloEs,
      kind: "series",
      poster: b.thumb.indexOf("https://") === 0 ? b.thumb : undefined,
      overview: (b.descEs ? "📰 " + b.descEs : "Sin resumen.") +
        "\n\n📖 Abre «📰 Leer la noticia completa» para todo el artículo." +
        "\n\nFuente: MyAnimeList News" + (traducida ? " · traducción automática" : ""),
      badges: [haceCuanto(b.fecha)]
    });
  }
  return items;
}

// Extrae el texto del artículo completo de la página de la noticia en MAL.
// Solo párrafos largos, sin basura de cookies, avisos o pie de página.
function extraerArticulo(html) {
  const paras = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = limpiarHTML(m[1]);
    if (!t || t.length < 60) continue;
    if (t.indexOf("cookie") >= 0 || t.indexOf("privacy") >= 0 || t.indexOf("consent") >= 0 ||
        t.indexOf("Terms of Service") >= 0 || t.indexOf("advertis") >= 0) continue;
    paras.push(t);
  }
  return paras.join("\n\n").slice(0, 6000);
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

// ---------- Episodios: la noticia completa ----------

// Al abrir una noticia, Kino pide sus episodios: el único episodio es
// «📰 Leer la noticia completa», con el artículo entero traducido (bajo
// demanda, solo para la noticia que la persona abre, con caché).
export async function episodes(ref) {
  await null;
  if (ref.indexOf("noticia:") === 0) {
    const nid = ref.slice(8);
    const url = "https://myanimelist.net/news/" + nid.replace(/\D+/g, "");
    let texto = kino.storage.get("notart-es:" + nid);
    if (!texto) {
      let cuerpo = "";
      let espanol = false;
      try {
        const html = await fetchTexto(url);
        cuerpo = extraerArticulo(html);
      } catch (e) {
        kino.log("episodios: artículo falló:", e.code || e.message);
      }
      if (cuerpo.length < 300) {
        // Respaldo: el resumen ya traducido que se guardó al listar noticias.
        cuerpo = kino.storage.get("notresumen-es:" + nid) || "No se pudo cargar la noticia.";
        espanol = true;
      }
      texto = espanol ? cuerpo : await traducirLargo(cuerpo);
      try { kino.storage.set("notart-es:" + nid, texto, 172800000); } catch (e2) { /* cache llena */ }
    }
    return {
      episodes: [{
        season: 1,
        number: 1,
        ref: "notexto:" + nid,
        title: "📰 Leer la noticia completa",
        overview: texto + "\n\n🌐 Fuente:\n" + url + "\n\nFuente: MyAnimeList News · traducción automática"
      }]
    };
  }
  return { episodes: [] };
}

// ---------- Reproducción ----------

// Las fichas de AniFeed son informativas (horarios y noticias): no hay
// video. Al tocar "ver" se explica amablemente en lugar de fallar raro.
export async function resolve(ref) {
  await null;
  throw kino.error("not_found", "sin video", { userMessage: "Esta ficha es informativa, no tiene video." });
}
