// Diagnóstico temporal: comprueba si las fuentes responden desde GitHub Actions
import fetch from 'node-fetch';
import fs from 'fs';

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const objetivos = [
  { nombre: 'agenda18_sin_headers', url: 'https://agenda18.com/agenda.json?v=1.12' },
  { nombre: 'agenda18_browser', url: 'https://agenda18.com/agenda.json?v=1.12', headers: { 'User-Agent': UA_BROWSER, 'Accept': 'application/json,text/plain,*/*' } },
  { nombre: 'config_futbollibre', url: 'https://futbollibrestream.pe/js//config.js?v=1.12', headers: { 'User-Agent': UA_BROWSER } },
  { nombre: 'megadeportes', url: 'https://megadeportesplus.su/agenda.php', headers: { 'User-Agent': UA_BROWSER } },
  { nombre: 'proxy_jina', url: 'https://r.jina.ai/https://agenda18.com/agenda.json' },
  { nombre: 'proxy_allorigins', url: 'https://api.allorigins.win/raw?url=https%3A%2F%2Fagenda18.com%2Fagenda.json' },
  { nombre: 'proxy_codetabs', url: 'https://api.codetabs.com/v1/proxy?quest=https://agenda18.com/agenda.json' }
];

function fechasDe(json) {
  try {
    const data = JSON.parse(json).data;
    if (!Array.isArray(data)) return null;
    const fechas = [...new Set(data.map((p) => p?.attributes?.date_diary).filter(Boolean))].sort();
    return { partidos: data.length, fechas };
  } catch (e) {
    return null;
  }
}

const resultados = [];

for (const objetivo of objetivos) {
  const inicio = Date.now();
  const registro = { nombre: objetivo.nombre, url: objetivo.url };
  const controller = new AbortController();
  const temporizador = setTimeout(() => controller.abort(), 20000);
  try {
    const respuesta = await fetch(objetivo.url, { headers: objetivo.headers || {}, signal: controller.signal, redirect: 'follow' });
    const texto = await respuesta.text();
    registro.status = respuesta.status;
    registro.ok = respuesta.ok;
    registro.ms = Date.now() - inicio;
    registro.bytes = texto.length;
    registro.contentType = respuesta.headers.get('content-type');
    registro.inicio = texto.slice(0, 160).replace(/\s+/g, ' ');
    registro.agenda = fechasDe(texto);
  } catch (error) {
    registro.ok = false;
    registro.error = `${error.name}: ${error.message}`;
    registro.causa = error.cause ? String(error.cause.message || error.cause) : null;
    registro.ms = Date.now() - inicio;
  } finally {
    clearTimeout(temporizador);
  }
  console.log(JSON.stringify(registro));
  resultados.push(registro);
}

const salida = {
  ejecutado_en: new Date().toISOString(),
  runner: process.env.RUNNER_NAME || 'local',
  node: process.version,
  resultados
};

fs.writeFileSync('diagnostico_resultado.json', JSON.stringify(salida, null, 2), 'utf-8');
console.log('Diagnóstico escrito en diagnostico_resultado.json');
