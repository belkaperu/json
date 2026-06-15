import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';

// Constantes
const CONFIG_URL = 'https://futbollibreoficial.pe/js/config.js?v=1.12';
const DEFAULT_URL = 'https://agenda18.com/agenda.json?v=1.12';
const URL_MEGADEPORTES = 'https://megadeportesplus.su/agenda.php';

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
    .replace(/[\u0300-\u036f]/g, "") // Quitar acentos
    .replace(/[^a-z0-9]/g, "");     // Quitar TODO lo que no sea letra o número (espacios, vs, guiones)
}

// Algoritmo de Coeficiente de Dice para calcular similitud de strings (0 a 1)
function calcularSimilitud(str1, str2) {
  const s1 = normalizarTexto(str1);
  const s2 = normalizarTexto(str2);
  
  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) return 0.0;

  const obternerBigramas = (str) => {
    const bigramas = new Set();
    for (let i = 0; i < str.length - 1; i++) {
      bigramas.add(str.substring(i, i + 2));
    }
    return bigramas;
  };

  const bigramas1 = obternerBigramas(s1);
  const bigramas2 = obternerBigramas(s2);
  
  let interseccion = 0;
  for (const bigrama of bigramas1) {
    if (bigramas2.has(bigrama)) interseccion++;
  }

  return (2.0 * interseccion) / (bigramas1.size + bigramas2.size);
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

    const resMegadeportes = await fetch(URL_MEGADEPORTES);
    const htmlMegadeportes = await resMegadeportes.text();
    const $ = cheerio.load(htmlMegadeportes);
    
    let canalesAgregadosTotales = 0;

    // Buscamos de manera más abierta en el menú (manejando variaciones de marcado de Megadeportes)
    const elementosPartidos = $('.menu li, .menu > li').filter((i, el) => $(el).find('ul').length > 0);

    elementosPartidos.each((i, elementoPartido) => {
      const textoPartidoMega = $(elementoPartido).find('> a').first().text().trim();
      if (!textoPartidoMega) return;

      // Ignorar ligas o textos fijos informativos si los hubiera
      if (textoPartidoMega.toLowerCase().includes("ver canales") || textoPartidoMega.length < 5) return;

      let mejorCoincidencia = null;
      let scoreMaximo = 0.45; // Umbral de tolerancia (45% de similitud estructural de letras)

      // Buscar el partido más idóneo en el JSON base
      dataFutbolazo.data.forEach(partidoFutbolazo => {
        const atributos = partidoFutbolazo.attributes;
        if (!atributos || !atributos.diary_description) return;

        const score = calcularSimilitud(textoPartidoMega, atributos.diary_description);
        
        if (score > scoreMaximo) {
          scoreMaximo = score;
          mejorCoincidencia = partidoFutbolazo;
        }
      });

      // Si encontramos un partido que coincide por estructura
      if (mejorCoincidencia) {
        const atributos = mejorCoincidencia.attributes;
        console.log(`🎯 [MATCH ${(scoreMaximo * 100).toFixed(0)}%] "${textoPartidoMega}" ➔ "${atributos.diary_description}"`);

        $(elementoPartido).find('ul li a, ul li span a').each((j, linkCanal) => {
          const clonLink = $(linkCanal).clone();
          clonLink.find('span').remove(); // Remover badges internos de texto si existen
          
          let textoCanal = clonLink.text().trim();
          const enlace = $(linkCanal).attr('href');

          if (textoCanal && enlace && enlace !== '#') {
            // Limpieza estética del canal
            textoCanal = textoCanal
              .replace(/megadeportes/gi, '')
              .replace(/[-\|()]/g, '')
              .trim();

            // Evitar duplicados de enlaces idénticos
            const yaExisteEnlace = atributos.embeds.data.some(emb => emb.attributes.embed_iframe === enlace);

            if (!yaExisteEnlace) {
              const nuevoId = Math.floor(Math.random() * 20000) + 10000;

              atributos.embeds.data.push({
                id: nuevoId,
                attributes: {
                  embed_name: textoCanal, // Nombre 100% limpio
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

    console.log(`\n🎉 PROCESO FINALIZADO: Se inyectaron exitosamente ${canalesAgregadosTotales} canales.`);
    
    fs.writeFileSync('agenda_combinada.json', JSON.stringify(dataFutbolazo, null, 2), 'utf-8');
    return dataFutbolazo;

  } catch (error) {
    console.error("❌ Error crítico en el motor de combinación:", error);
  }
}

combinarAgendas();
