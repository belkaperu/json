import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';

/**
 * Scraper de la agenda combinada.
 *
 * Reglas de oro (para que la agenda NUNCA se quede con los partidos de ayer):
 *  1. La fuente sólo publica los partidos del día, así que si un fetch falla hay que reintentar,
 *     no quedarse con el archivo anterior.
 *  2. Si la fuente responde una agenda válida pero vacía, se escribe vacía (la app muestra
 *     "sin partidos") en lugar de dejar la fecha anterior pegada.
 *  3. Si la fuente falla del todo, se conserva el archivo anterior pero el proceso termina con
 *     código de error para que GitHub Actions lo marque en rojo.
 *  4. Si la agenda nueva es MÁS VIEJA que la última guardada, no se sobreescribe.
 */

const ARCHIVO_SALIDA = process.env.AGENDA_ARCHIVO || 'agenda_combinada.json';

// Fuentes de la agenda base, en orden de preferencia.
// (AGENDA_URL_PERMITIDA permite apuntar a otra URL para pruebas locales.)
const CONFIG_URL = process.env.CONFIG_URL || 'https://futbollibrestream.pe/js//config.js?v=1.12';
const FUENTES_AGENDA = process.env.AGENDA_URL
  ? [process.env.AGENDA_URL]
  : ['https://agenda18.com/agenda.json?v=1.12', 'https://agenda18.com/agenda.json'];

// Canales extra (opcional). Se ignora silenciosamente si el sitio no responde.
const URL_MEGADEPORTES = process.env.MEGADEPORTES_URL || 'https://megadeportesplus.su/agenda.php';

const TIMEOUT_MS = 20000;
const REINTENTOS = 3;

const HEADERS_BROWSER = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Utilidades de red
// ---------------------------------------------------------------------------

async function fetchConTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pide un JSON con reintentos y espera progresiva.
 * Devuelve { ok, json, url, error }.
 */
async function pedirJson(url, { reintentos = REINTENTOS, validador = () => true } = {}) {
  let ultimoError = null;

  for (let intento = 1; intento <= reintentos; intento++) {
    try {
      // Cache-buster: el CDN de la fuente cachea fuerte y si no, devuelve lo de ayer.
      const separador = url.includes('?') ? '&' : '?';
      const urlFinal = `${url}${separador}_=${Date.now()}`;
      const respuesta = await fetchConTimeout(urlFinal, {
        headers: { ...HEADERS_BROWSER, Accept: 'application/json,text/plain,*/*' }
      });

      if (!respuesta.ok) {
        throw new Error(`HTTP ${respuesta.status} ${respuesta.statusText || ''}`.trim());
      }

      const texto = await respuesta.text();
      if (!texto || texto.trim().length === 0) {
        throw new Error('respuesta vacía');
      }

      let json;
      try {
        json = JSON.parse(texto);
      } catch (e) {
        throw new Error(`respuesta no es JSON (${texto.slice(0, 80).replace(/\s+/g, ' ')})`);
      }

      if (!validador(json)) {
        throw new Error('JSON con estructura inesperada (sin array "data")');
      }

      return { ok: true, json, url };
    } catch (error) {
      ultimoError = error.name === 'AbortError' ? new Error(`timeout de ${TIMEOUT_MS} ms`) : error;
      if (intento < reintentos) {
        const pausa = 2000 * intento;
        console.warn(
          `   ↻ Intento ${intento}/${reintentos} falló en ${url} (${ultimoError.message}). Reintentando en ${pausa / 1000}s...`
        );
        await esperar(pausa);
      }
    }
  }

  return { ok: false, error: ultimoError, url };
}

// ---------------------------------------------------------------------------
// Utilidades de texto / similitud
// ---------------------------------------------------------------------------

function normalizarTexto(texto) {
  if (!texto) return '';
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function calcularSimilitud(str1, str2) {
  const s1 = normalizarTexto(str1);
  const s2 = normalizarTexto(str2);

  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) return 0.0;

  const obtenerBigramas = (str) => {
    const bigramas = new Set();
    for (let i = 0; i < str.length - 1; i++) {
      bigramas.add(str.substring(i, i + 2));
    }
    return bigramas;
  };

  const bigramas1 = obtenerBigramas(s1);
  const bigramas2 = obtenerBigramas(s2);

  let interseccion = 0;
  for (const bigrama of bigramas1) {
    if (bigramas2.has(bigrama)) interseccion++;
  }

  return (2.0 * interseccion) / (bigramas1.size + bigramas2.size);
}

// ---------------------------------------------------------------------------
// Agenda base
// ---------------------------------------------------------------------------

const esAgendaValida = (json) => !!json && Array.isArray(json.data);

async function obtenerAgendaUrlDesdeConfig() {
  try {
    const respuesta = await fetchConTimeout(CONFIG_URL, { headers: HEADERS_BROWSER }, 8000);
    if (!respuesta.ok) return null;
    const texto = await respuesta.text();
    const match = texto.match(/export\s+const\s+AGENDA_URL\s*=\s*["']([^"']+)["']/);
    return match && match[1] ? match[1] : null;
  } catch {
    return null;
  }
}

async function descargarAgendaBase() {
  const urls = [];

  const urlConfig = await obtenerAgendaUrlDesdeConfig();
  if (urlConfig) {
    urls.push(urlConfig);
    console.log(`🔗 URL de agenda detectada en config.js: ${urlConfig}`);
  } else {
    console.log('ℹ️ config.js no disponible; se usan las fuentes directas.');
  }

  for (const url of FUENTES_AGENDA) {
    if (!urls.includes(url)) urls.push(url);
  }

  for (const url of urls) {
    console.log(`📥 Descargando agenda base: ${url}`);
    const resultado = await pedirJson(url, { validador: esAgendaValida });
    if (resultado.ok) {
      console.log(`✅ Agenda base obtenida (${resultado.json.data.length} partidos): ${url}`);
      return { ...resultado, urlsIntentadas: urls };
    }
    console.warn(`   ✖ ${url} → ${resultado.error?.message || 'error desconocido'}`);
  }

  return { ok: false, error: new Error('ninguna fuente de agenda respondió'), urlsIntentadas: urls };
}

// ---------------------------------------------------------------------------
// Canales extra (Megadeportes)
// ---------------------------------------------------------------------------

function inyectarCanalesMegadeportes(partidos) {
  let canalesAgregados = 0;

  return (async () => {
    try {
      console.log('🔎 Intentando cargar canales extra (Megadeportes)...');
      const respuesta = await fetchConTimeout(URL_MEGADEPORTES, { headers: HEADERS_BROWSER }, 12000);
      if (!respuesta.ok) {
        throw new Error(`HTTP ${respuesta.status} ${respuesta.statusText || ''}`.trim());
      }

      const $ = cheerio.load(await respuesta.text());
      const elementosPartidos = $('.menu li, .menu > li').filter((i, el) => $(el).find('ul').length > 0);

      elementosPartidos.each((i, elementoPartido) => {
        const textoPartidoMega = $(elementoPartido).find('> a').first().text().trim();
        if (!textoPartidoMega) return;
        if (textoPartidoMega.toLowerCase().includes('ver canales') || textoPartidoMega.length < 5) return;

        let mejorCoincidencia = null;
        let scoreMaximo = 0.45;

        partidos.forEach((partido) => {
          const atributos = partido.attributes;
          if (!atributos || !atributos.diary_description) return;
          const score = calcularSimilitud(textoPartidoMega, atributos.diary_description);
          if (score > scoreMaximo) {
            scoreMaximo = score;
            mejorCoincidencia = partido;
          }
        });

        if (!mejorCoincidencia) return;

        const atributos = mejorCoincidencia.attributes;
        if (!atributos.embeds) atributos.embeds = { data: [] };
        if (!Array.isArray(atributos.embeds.data)) atributos.embeds.data = [];

        console.log(`🎯 [MATCH ${(scoreMaximo * 100).toFixed(0)}%] "${textoPartidoMega}" ➔ "${atributos.diary_description}"`);

        $(elementoPartido)
          .find('ul li a, ul li span a')
          .each((j, linkCanal) => {
            const clonLink = $(linkCanal).clone();
            clonLink.find('span').remove();

            let textoCanal = clonLink.text().trim();
            const enlace = $(linkCanal).attr('href');
            if (!textoCanal || !enlace || enlace === '#') return;

            textoCanal = textoCanal
              .replace(/megadeportes/gi, '')
              .replace(/[-|()]/g, '')
              .trim();

            const yaExiste = atributos.embeds.data.some((emb) => emb?.attributes?.embed_iframe === enlace);
            if (yaExiste) return;

            atributos.embeds.data.push({
              id: Date.now() % 100000 + Math.floor(Math.random() * 1000),
              attributes: {
                embed_name: textoCanal,
                idioma: 'Español/Alternativo',
                embed_iframe: enlace
              }
            });
            canalesAgregados++;
          });
      });
    } catch (error) {
      console.warn(`⚠️ Canales extra no disponibles (${error.message}). Se continúa con la agenda base.`);
    }

    return canalesAgregados;
  })();
}

// ---------------------------------------------------------------------------
// Frescura del archivo
// ---------------------------------------------------------------------------

function leerAgendaAnterior() {
  try {
    if (!fs.existsSync(ARCHIVO_SALIDA)) return null;
    const anterior = JSON.parse(fs.readFileSync(ARCHIVO_SALIDA, 'utf-8'));
    if (!esAgendaValida(anterior)) return null;
    return anterior;
  } catch {
    return null;
  }
}

function fechaMaxima(agenda) {
  const fechas = (agenda?.data || [])
    .map((p) => p?.attributes?.date_diary)
    .filter((f) => typeof f === 'string' && f.length >= 10)
    .sort();
  return fechas.length ? fechas[fechas.length - 1] : null;
}

function resumen(agenda) {
  const porFecha = {};
  for (const partido of agenda?.data || []) {
    const fecha = partido?.attributes?.date_diary || 'sin fecha';
    porFecha[fecha] = (porFecha[fecha] || 0) + 1;
  }
  return Object.entries(porFecha)
    .map(([fecha, cantidad]) => `${fecha}: ${cantidad}`)
    .join(' | ');
}

// ---------------------------------------------------------------------------
// Proceso principal
// ---------------------------------------------------------------------------

async function combinarAgendas() {
  console.log(`🚀 Iniciando sincronización — ${new Date().toISOString()}`);

  const base = await descargarAgendaBase();

  if (!base.ok) {
    const anterior = leerAgendaAnterior();
    console.error(`❌ No se pudo actualizar la agenda: ${base.error?.message || 'error desconocido'}`);
    console.error(`   Fuentes intentadas: ${(base.urlsIntentadas || []).join(', ')}`);
    if (anterior) {
      console.error(`   ⚠️ Se conserva el archivo anterior (${resumen(anterior)}).`);
    }
    process.exitCode = 1;
    return null;
  }

  const agenda = base.json;
  const anterior = leerAgendaAnterior();
  const fechaNueva = fechaMaxima(agenda);
  const fechaAnterior = fechaMaxima(anterior);

  // Protección contra retrocesos: nunca pisar una agenda más nueva con una más vieja.
  if (fechaNueva && fechaAnterior && fechaNueva < fechaAnterior && agenda.data.length > 0) {
    console.warn(
      `⚠️ La fuente devolvió una agenda más vieja (${fechaNueva}) que la guardada (${fechaAnterior}). No se sobreescribe.`
    );
    process.exitCode = 1;
    return anterior;
  }

  agenda.data = agenda.data.filter((p) => p && p.attributes && p.attributes.diary_description);

  console.log(`📅 Partidos recibidos: ${agenda.data.length} → ${resumen(agenda)}`);

  if (agenda.data.length > 0) {
    const canales = await inyectarCanalesMegadeportes(agenda.data);
    console.log(`🎉 Se inyectaron ${canales} canales extra.`);
  } else {
    // Agenda legítimamente vacía (la fuente sólo publica el día en curso).
    // Se escribe vacía para no seguir mostrando los partidos de ayer.
    console.log('ℹ️ La fuente no tiene partidos publicados en este momento. Se escribe agenda vacía.');
  }

  // Se mantiene EXACTAMENTE la estructura que consume la app: { data: [...], meta: { pagination: {...} } }
  const salida = { ...agenda, data: agenda.data };
  if (salida.meta && typeof salida.meta === 'object') {
    salida.meta = { ...salida.meta };
    salida.meta.pagination = {
      ...(salida.meta.pagination || {}),
      page: 1,
      pageSize: agenda.data.length,
      pageCount: agenda.data.length > 0 ? 1 : 0,
      total: agenda.data.length
    };
  }

  fs.writeFileSync(ARCHIVO_SALIDA, JSON.stringify(salida, null, 2), 'utf-8');
  console.log(`✅ agenda_combinada.json escrito (${agenda.data.length} partidos, fecha ${fechaNueva || 'sin fecha'}).`);
  return salida;
}

combinarAgendas().catch((error) => {
  console.error('❌ Error crítico en el motor de combinación:', error);
  process.exitCode = 1;
});
