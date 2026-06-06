import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';

// Constantes
const CONFIG_URL = 'https://futbollibregol.pe/js/config.js?v=1.12';
const DEFAULT_URL = 'https://agenda18.com/agenda.json?v=1.12';  // Tu URL original que funciona
const URL_MEGADEPORTES = 'https://megadeportesplus.su/agenda.php';

// Función para obtener la URL desde config.js (con fallback a la original)
async function obtenerAgendaUrl() {
    try {
        const response = await fetch(CONFIG_URL);
        const texto = await response.text();
        const match = texto.match(/export\s+const\s+AGENDA_URL\s*=\s*["']([^"']+)["']/);
        if (match && match[1]) {
            console.log(`📡 URL obtenida de config.js: ${match[1]}`);
            // Verificamos si la URL es accesible y devuelve JSON válido
            try {
                const testResp = await fetch(match[1]);
                const testJson = await testResp.json();
                if (testJson && testJson.data && Array.isArray(testJson.data)) {
                    console.log('✅ La URL funciona correctamente. Se usará esta.');
                    return match[1];
                } else {
                    console.warn('⚠️ La URL de config.js no devuelve la estructura esperada. Usando URL por defecto.');
                    return DEFAULT_URL;
                }
            } catch (err) {
                console.warn(`⚠️ Error al probar URL de config.js: ${err.message}. Usando URL por defecto.`);
                return DEFAULT_URL;
            }
        } else {
            console.warn('⚠️ No se encontró AGENDA_URL en config.js. Usando URL por defecto.');
            return DEFAULT_URL;
        }
    } catch (error) {
        console.error('❌ Error leyendo config.js:', error.message);
        console.log('📌 Usando URL por defecto.');
        return DEFAULT_URL;
    }
}

// El resto del script es EXACTAMENTE IGUAL (solo cambia la forma de obtener URL_FUTBOLAZO)
function limpiarTexto(texto) {
  if (!texto) return "";
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, ""); 
}

async function combinarAgendas() {
  try {
    // Aquí se obtiene la URL dinámica (con fallback garantizado)
    const URL_FUTBOLAZO = await obtenerAgendaUrl();
    console.log("1. Descargando datos desde:", URL_FUTBOLAZO);
    
    const resFutbolazo = await fetch(URL_FUTBOLAZO);
    const dataFutbolazo = await resFutbolazo.json();

    // Verificación extra: si no tiene datos, abortar con mensaje claro
    if (!dataFutbolazo.data || dataFutbolazo.data.length === 0) {
        console.error("❌ El JSON descargado no contiene datos de partidos. Revisa la URL.");
        return;
    }

    console.log("2. Descargando HTML de Megadeportes...");
    const resMegadeportes = await fetch(URL_MEGADEPORTES);
    const htmlMegadeportes = await resMegadeportes.text();

    const $ = cheerio.load(htmlMegadeportes);
    let canalesAgregadosTotales = 0;

    console.log("3. Procesando estructura exacta de Megadeportes...");

    $('.menu > li').each((i, elementoPartido) => {
      const textoPartidoMega = $(elementoPartido).find('> a').text();
      
      if (!textoPartidoMega) return;

      const textoMegaLimpio = limpiarTexto(textoPartidoMega)
        .replace(/amistoso internacional|primera division|sub\d+|serie a de ecuador/gi, '');

      const palabrasClave = textoMegaLimpio
        .replace(/vs/gi, '')
        .split(' ')
        .map(p => p.trim())
        .filter(p => p.length > 3); 

      if (palabrasClave.length === 0) return;

      if (dataFutbolazo.data && Array.isArray(dataFutbolazo.data)) {
        dataFutbolazo.data.forEach(partidoFutbolazo => {
          const atributos = partidoFutbolazo.attributes;
          if (!atributos || !atributos.diary_description || !atributos.embeds || !atributos.embeds.data) return;

          const descripcionFutbolazoLimpia = limpiarTexto(atributos.diary_description);

          const esMismoPartido = palabrasClave.some(palabra => descripcionFutbolazoLimpia.includes(palabra));

          if (esMismoPartido) {
            console.log(`-> Cruzando partido: ${atributos.diary_description}`);

            $(elementoPartido).find('ul li a').each((j, linkCanal) => {
              const clonLink = $(linkCanal).clone();
              clonLink.find('span').remove();
              
              let textoCanal = clonLink.text().trim();
              const enlace = $(linkCanal).attr('href');

              if (textoCanal && enlace) {
                textoCanal = textoCanal
                  .replace(/megadeportes/gi, '')
                  .replace(/[-\|()]/g, '')
                  .trim();

                const yaExisteEnlace = atributos.embeds.data.some(emb => emb.attributes.embed_iframe === enlace);

                if (!yaExisteEnlace) {
                  const nuevoId = Math.floor(Math.random() * 10000) + 5000;

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
      }
    });

    console.log(`\n=== PROCESO COMPLETADO: Se inyectaron ${canalesAgregadosTotales} canales en total ===`);
    
    fs.writeFileSync('agenda_combinada.json', JSON.stringify(dataFutbolazo, null, 2), 'utf-8');
    console.log("-> ¡Archivo 'agenda_combinada.json' guardado con éxito!");

    return dataFutbolazo;

  } catch (error) {
    console.error("Hubo un error crítico en el proceso de combinación:", error);
  }
}

combinarAgendas();
