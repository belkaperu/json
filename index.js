import * as cheerio from 'cheerio';
import fs from 'fs';
import crypto from 'crypto';

// Constantes
const CONFIG_URL = 'https://futbollibregol.pe/js/config.js?v=1.12';
const DEFAULT_URL = 'https://agenda18.com/agenda.json?v=1.12';  
const URL_MEGADEPORTES = 'https://futbol-libres.su/agenda/';

/**
 * Obtiene los datos base de la agenda
 */
async function obtenerDatosAgendaBase() {
    try {
        const response = await fetch(CONFIG_URL);
        const texto = await response.text();
        const match = texto.match(/export\s+const\s+AGENDA_URL\s*=\s*["']([^"']+)["']/);
        
        let urlDestino = DEFAULT_URL;
        if (match && match[1]) {
            console.log(`📡 URL encontrada en config.js: ${match[1]}`);
            urlDestino = match[1];
        }

        try {
            const res = await fetch(urlDestino);
            const json = await res.json();
            if (json && json.data && Array.isArray(json.data)) {
                return json;
            }
            throw new Error('Estructura de JSON inválida');
        } catch (err) {
            console.warn(`⚠️ Error en URL dinámica. Usando URL por defecto...`);
            const resDefault = await fetch(DEFAULT_URL);
            return await resDefault.json();
        }
    } catch (error) {
        console.error('❌ Error crítico al obtener agenda base:', error.message);
        return null;
    }
}

/**
 * Limpia el texto de forma profunda para emparejar cadenas con acentos o caracteres extraños
 */
function limpiarTexto(texto) {
    if (!texto) return "";
    return texto
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remueve acentos de "Perú" o "España" -> "peru", "espana"
        .replace(/[^a-z0-9 ]/g, "")      // Remueve caracteres especiales y símbolos
        .trim();
}

/**
 * Valida la coincidencia exacta de los equipos del partido
 */
function esMismoPartido(textoMega, textoFutbolazo) {
    const limpiarMega = limpiarTexto(textoMega).replace(/\bvs\b/gi, ' ');
    const limpiarFutbolazo = limpiarTexto(textoFutbolazo).replace(/\bvs\b/gi, ' ');

    // Lista de palabras a ignorar (comunes en eventos de fútbol)
    const palabrasAIgnorar = ['amistoso', 'internacional', 'primera', 'division', 'serie', 'en', 'vivo', 'online', 'gratis'];

    // Filtro optimizado: Ahora acepta palabras de 3 letras o más para no ignorar países/equipos cortos (ej. "usa", "peru")
    const palabrasMega = limpiarMega
        .split(/\s+/)
        .map(p => p.trim())
        .filter(p => p.length >= 3 && !palabrasAIgnorar.includes(p));

    if (palabrasMega.length === 0) return false;

    let coincidencias = 0;
    palabrasMega.forEach(palabra => {
        if (limpiarFutbolazo.includes(palabra)) {
            coincidencias++;
        }
    });

    // Si el evento tiene pocas palabras clave (ej: "Peru" "Espana" = 2 palabras), basta con que coincida 1 para eventos de corto nombre
    // Si tiene más palabras (ej: "Real Madrid vs Atletico Madrid"), exigirá al menos 2.
    const umbralMinimo = palabrasMega.length <= 2 ? 1 : 2;
    
    return coincidencias >= umbralMinimo;
}

async function combinarAgendas() {
    try {
        console.log("1. Cargando datos de la agenda base...");
        const dataFutbolazo = await obtenerDatosAgendaBase();

        if (!dataFutbolazo || !dataFutbolazo.data || dataFutbolazo.data.length === 0) {
            console.error("❌ No se obtuvieron partidos base. Abortando proceso.");
            return;
        }

        console.log("2. Descargando HTML de Megadeportes...");
        const resMegadeportes = await fetch(URL_MEGADEPORTES);
        const htmlMegadeportes = await resMegadeportes.text();

        const $ = cheerio.load(htmlMegadeportes);
        let canalesAgregadosTotales = 0;

        console.log("3. Analizando partidos e inyectando canales faltantes...");

        // Iterar sobre los bloques de partidos de Megadeportes
        $('.menu > li').each((i, elementoPartido) => {
            const textoPartidoMega = $(elementoPartido).find('> a').text();
            if (!textoPartidoMega) return;

            // Buscar coincidencia usando el comparador mejorado de países y equipos cortos
            const partidoBaseEncontrado = dataFutbolazo.data.find(partidoFutbolazo => {
                const atributos = partidoFutbolazo.attributes;
                if (!atributos || !atributos.diary_description) return false;
                
                return esMismoPartido(textoPartidoMega, atributos.diary_description);
            });

            // Si hay match (ej: "Peru vs España" coincide con "Perú vs España" en el JSON)
            if (partidoBaseEncontrado) {
                const atributos = partidoBaseEncontrado.attributes;
                
                if (!atributos.embeds) atributos.embeds = { data: [] };
                if (!atributos.embeds.data) atributos.embeds.data = [];

                // Buscar los enlaces dentro del submenú <ul> <li> de este partido específico
                $(elementoPartido).find('ul li a').each((j, linkCanal) => {
                    const clonLink = $(linkCanal).clone();
                    clonLink.find('span, img, i').remove(); // Limpia iconos, imágenes o badges de canales
                    
                    let textoCanal = clonLink.text().trim();
                    const enlace = $(linkCanal).attr('href');

                    if (textoCanal && enlace) {
                        // Limpiar el nombre del canal para que quede legible (ej: "Movistar Deportes", "VIX+")
                        textoCanal = textoCanal
                            .replace(/megadeportes/gi, '')
                            .replace(/[-\|()]/g, '')
                            .replace(/\s+/g, ' ')
                            .trim();

                        // Verificar que no se duplique el enlace iframe exacto
                        const yaExisteEnlace = atributos.embeds.data.some(emb => 
                            emb.attributes && emb.attributes.embed_iframe === enlace
                        );

                        if (!yaExisteEnlace) {
                            const nuevoId = crypto.randomBytes(2).readUInt16BE(0) + 10000;

                            atributos.embeds.data.push({
                                id: nuevoId,
                                attributes: {
                                    embed_name: textoCanal,
                                    idioma: "Español/Alternativo",
                                    embed_iframe: enlace
                                }
                            });
                            console.log(` ✅ Canal [${textoCanal}] inyectado con éxito en: "${atributos.diary_description}"`);
                            canalesAgregadosTotales++;
                        }
                    }
                });
            }
        });

        console.log(`\n=== 🏁 PROCESO COMPLETADO: Se inyectaron ${canalesAgregadosTotales} canales en total ===`);
        
        // Guardar el archivo final unificado
        fs.writeFileSync('agenda_combinada.json', JSON.stringify(dataFutbolazo, null, 2), 'utf-8');
        console.log("-> Archivo 'agenda_combinada.json' actualizado y guardado.");

        return dataFutbolazo;

    } catch (error) {
        console.error("❌ Ocurrió un error crítico unificando las agendas:", error);
    }
}

combinarAgendas();
