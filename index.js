import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
const URL_FUTBOLAZO = 'https://fubolazo.com/agenda.json?v=1.12';
const URL_MEGADEPORTES = 'https://megadeportes.de/agenda.html';

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

    // Recorremos cada elemento <li> de la clase "menu" que representa un partido
    $('.menu > li').each((i, elementoPartido) => {
      // Extraemos el texto del partido (ej: "Amistoso Internacional: Colombia vs Costa Rica 00:00")
      const textoPartidoMega = $(elementoPartido).find('> a').text().toLowerCase();
      
      if (!textoPartidoMega) return;

      // Obtenemos los equipos limpiando el texto del partido de Megadeportes
      const palabrasClave = textoPartidoMega
        .replace(/amistoso internacional:|primera división:|serie a de ecuador:/gi, '')
        .replace(/vs\.?|v\.s\.?/gi, '')
        .split(' ')
        .map(p => p.trim())
        .filter(p => p.length > 3); // Nos quedamos con palabras representativas como "peñarol", "colombia", etc.

      if (palabrasClave.length === 0) return;

      // Buscamos si este partido existe en el JSON de Fútbolazo
      if (dataFutbolazo.data && Array.isArray(dataFutbolazo.data)) {
        dataFutbolazo.data.forEach(partidoFutbolazo => {
          const atributos = partidoFutbolazo.attributes;
          if (!atributos || !atributos.diary_description || !atributos.embeds || !atributos.embeds.data) return;

          const descripcionFutbolazo = atributos.diary_description.toLowerCase();

          // El partido coincide si el texto de Fútbolazo contiene las palabras clave de Megadeportes
          const esMismoPartido = palabrasClave.some(palabra => descripcionFutbolazo.includes(palabra));

          if (esMismoPartido) {
            console.log(`-> Cruzando partido: ${atributos.diary_description}`);

            // Buscamos los canales ÚNICAMENTE dentro de la lista (ul) de este partido específico
            $(elementoPartido).find('ul li a').each((j, linkCanal) => {
              // Clonamos para remover el span interno (ej: "<span>Calidad 720p</span>") y obtener solo el texto del canal limpio
              const clonLink = $(linkCanal).clone();
              clonLink.find('span').remove();
              
              let textoCanal = clonLink.text().trim();
              const enlace = $(linkCanal).attr('href');

              if (textoCanal && enlace) {
                // REGLA: Eliminar cualquier rastro de "megadeportes" (por si acaso viniera en el string)
                textoCanal = textoCanal
                  .replace(/megadeportes/gi, '')
                  .replace(/[-\|()]/g, '')
                  .trim();

                // Validamos duplicados de URLs exactas para no meter basura repetida
                const yaExisteEnlace = atributos.embeds.data.some(emb => emb.attributes.embed_iframe === enlace);

                if (!yaExisteEnlace) {
                  const nuevoId = Math.floor(Math.random() * 10000) + 5000;

                  // Insertamos el canal en los embeds del partido de Fútbolazo
                  atributos.embeds.data.push({
                    id: nuevoId,
                    attributes: {
                      embed_name: textoCanal, // Ejemplo final: "Disney+", "Deportes RCN", "Caracol TV"
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


fs.writeFileSync('agenda_combinada.json', JSON.stringify(dataFutbolazo, null, 2), 'utf-8');
    console.log("-> ¡Archivo 'agenda_combinada.json' guardado con éxito!");
    return dataFutbolazo;

  } catch (error) {
    console.error("Hubo un error crítico en el proceso de combinación:", error);
  }
}

combinarAgendas();