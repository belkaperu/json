import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';

// Constantes
const CONFIG_URL = 'https://futbollibrestream.pe/js//config.js?v=1.12';
const DEFAULT_URL = 'https://agenda18.com/agenda.json?v=1.12';
const URL_MEGADEPORTES = 'https://megadeportesplus.su/agenda.php';

// Cabeceras que simulan un navegador real (evitan bloqueos básicos)
const HEADERS_MEGADEPORTES = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

// Obtener la URL dinámica de la agenda
async function obtenerAgendaUrl() {
  try {
    const response = await fetch(CONFIG_URL);
    const texto = await response.text();
    const match = texto.match(/export\s+const\s+AGENDA_URL\s*=\s*["']([^"']+)["']/);
    if (match && match[1]) {
      try {
        const testResp = await fetch(match[1]);
        const testJson = await testResp.json();
        if (testJson && testJson.data && Array.isArray(testJson.data)) {
          return match[1];
        }
      } catch (err) {
        return DEFAULT_URL;
      }
    }
    return DEFAULT_URL;
  } catch (error) {
    return DEFAULT_URL;
  }
}

// Limpieza profunda de texto para normalizar strings
function normalizarTexto(texto) {
  if (!texto) return "";
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Algoritmo de Coeficiente de Dice para calcular similitud de strings (0 a 1)
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

// Función para fetch con timeout (node-fetch no tiene opción nativa, usamos AbortController)
async function fetchConTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

async function combinarAgendas() {
  try {
    const URL_FUTBULAZO = await obtenerAgendaUrl();
    console.log("🚀 Iniciando sincronización definitiva...");
    
    const resFutbolazo = await fetch(URL_FUTBULAZO);
    const dataFutbolazo = await resFutbolazo.json();

    if (!dataFutbolazo.data || dataFutbolazo.data.length === 0) {
      console.error("❌ Error: La agenda base no contiene partidos.");
      return;
    }

    let canalesAgregadosTotales = 0;

    // Intento de carga de Megadeportes con manejo de errores y cabeceras de navegador
    try {
      console.log("🔎 Intentando cargar Megadeportes...");
      const resMegadeportes = await fetchConTimeout(URL_MEGADEPORTES, {
        headers: HEADERS_MEGADEPORTES,
        follow: 3  // Seguir hasta 3 redirecciones
      }, 15000); // 15 segundos de timeout

      if (!resMegadeportes.ok) {
        throw new Error(`Respuesta HTTP: ${resMegadeportes.status} ${resMegadeportes.statusText}`);
      }

      const htmlMegadeportes = await resMegadeportes.text();
      const $ = cheerio.load(htmlMegadeportes);

      const elementosPartidos = $('.menu li, .menu > li').filter((i, el) => $(el).find('ul').length > 0);

      elementosPartidos.each((i, elementoPartido) => {
        const textoPartidoMega = $(elementoPartido).find('> a').first().text().trim();
        if (!textoPartidoMega) return;

        if (textoPartidoMega.toLowerCase().includes("ver canales") || textoPartidoMega.length < 5) return;

        let mejorCoincidencia = null;
        let scoreMaximo = 0.45;

        dataFutbolazo.data.forEach(partidoFutbolazo => {
          const atributos = partidoFutbolazo.attributes;
          if (!atributos || !atributos.diary_description) return;

          const score = calcularSimilitud(textoPartidoMega, atributos.diary_description);
          
          if (score > scoreMaximo) {
            scoreMaximo = score;
            mejorCoincidencia = partidoFutbolazo;
          }
        });

        if (mejorCoincidencia) {
          const atributos = mejorCoincidencia.attributes;
          console.log(`🎯 [MATCH ${(scoreMaximo * 100).toFixed(0)}%] "${textoPartidoMega}" ➔ "${atributos.diary_description}"`);

          $(elementoPartido).find('ul li a, ul li span a').each((j, linkCanal) => {
            const clonLink = $(linkCanal).clone();
            clonLink.find('span').remove();
            
            let textoCanal = clonLink.text().trim();
            const enlace = $(linkCanal).attr('href');

            if (textoCanal && enlace && enlace !== '#') {
              textoCanal = textoCanal
                .replace(/megadeportes/gi, '')
                .replace(/[-\|()]/g, '')
                .trim();

              const yaExisteEnlace = atributos.embeds.data.some(emb => emb.attributes.embed_iframe === enlace);

              if (!yaExisteEnlace) {
                const nuevoId = Math.floor(Math.random() * 20000) + 10000;
                atributos.embeds.data.push({
                  id: nuevoId,
                  attributes: {
                    embed_name: textoCanal,
                    idioma: "Español/Alternativo",
                    embed_iframe: enlace
                  }
                });
                canalesAgregadosTotales++;
              }
            }
          });
        }
      });

    } catch (errorMegadeportes) {
      console.warn(`⚠️ No se pudo acceder a Megadeportes: ${errorMegadeportes.message}`);
      console.log("⏭️ Continuando con la agenda base (sin canales de Megadeportes)...");
    }

    console.log(`\n🎉 PROCESO FINALIZADO: Se inyectaron ${canalesAgregadosTotales} canales desde Megadeportes.`);
    
    fs.writeFileSync('agenda_combinada.json', JSON.stringify(dataFutbolazo, null, 2), 'utf-8');
    return dataFutbolazo;

  } catch (error) {
    console.error("❌ Error crítico en el motor de combinación:", error);
  }
}

combinarAgendas();
