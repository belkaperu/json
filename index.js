import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';

const URL_FUTBOLAZO = 'https://agenda18.com/agenda.json?v=1.12';
const URL_MEGADEPORTES = 'https://megadeportes.de/agenda.html';

// NUEVA FUNCIÓN: Elimina tildes, convierte a minúsculas y limpia códigos como \u00e1
function limpiarTexto(texto) {
  if (!texto) return "";
  return texto
    .toLowerCase()
    // Decodifica caracteres Unicode si vienen en formato de texto puro
    .normalize("NFD")
    // Elimina físicamente las tildes (las separa de las letras y las borra)
    .replace(/[\u0300-\u036f]/g, "")
    // Por si acaso, limpiamos eñes o caracteres especiales comunes
    .replace(/[^a-z0-9 ]/g, ""); 
}

async function combinarAgendas() {
  try {
    console.log("1. Descargando datos de Fútbolazo...");
    const resFutbolazo = await fetch(URL_FUTBOLAZO);
    const dataFutbolazo = await resFutbolazo.json();

    console.log("2. Descargando HTML de Megadeportes...");
    const resMegadeportes = await fetch(URL_MEGADEPORTES);
    const htmlMegadeportes = await resMegadeportes.text();

    const $ = cheerio.load(htmlMegadeportes);
    let canalesAgregadosTotales = 0;

    console.log("3. Procesando estructura exacta de Megadeportes...");

    $('.menu > li').each((i, elementoPartido) => {
      const textoPartidoMega = $(elementoPartido).find('> a').text();
      
      if (!textoPartidoMega) return;

      // Limpiamos el texto completo de Megadeportes usando la nueva función
      const textoMegaLimpio = limpiarTexto(textoPartidoMega)
        .replace(/amistoso internacional|primera division|sub\d+|serie a de ecuador/gi, '');

      // Creamos las palabras clave basadas en el texto ya limpio (sin tildes)
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

          // CAMBIO CLAVE: Limpiamos también el texto de Fútbolazo antes de comparar
          const descripcionFutbolazoLimpia = limpiarTexto(atributos.diary_description);

          // Ahora la comparación es 100% limpia: "canada" incluirá a "canada"
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
