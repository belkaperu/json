import fetch from 'node-fetch';
import fs from 'fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const casos = [
  { nombre: 'sin_cache_buster', url: 'https://agenda18.com/agenda.json?v=1.12' },
  { nombre: 'con_cache_buster', url: `https://agenda18.com/agenda.json?v=1.12&_=${Date.now()}` },
  { nombre: 'sin_query', url: 'https://agenda18.com/agenda.json' },
  { nombre: 'config_js', url: 'https://futbollibrestream.pe/js//config.js?v=1.12', texto: true }
];
const salida = [];
for (const c of casos) {
  const r = { nombre: c.nombre, url: c.url };
  try {
    const res = await fetch(c.url, { headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } });
    const body = await res.text();
    r.status = res.status;
    r.bytes = body.length;
    for (const h of ['date', 'age', 'cache-control', 'etag', 'last-modified', 'cf-cache-status', 'server', 'content-type']) {
      r[h] = res.headers.get(h);
    }
    if (!c.texto) {
      try {
        const j = JSON.parse(body);
        r.partidos = j.data?.length;
        r.fechas = [...new Set((j.data || []).map((p) => p.attributes?.date_diary))];
        r.primer_hora_actualizada = (j.data || []).map((p) => p.attributes?.updatedAt).filter(Boolean).sort().pop();
      } catch (e) { r.parse = 'fallo: ' + body.slice(0, 100); }
    } else {
      const m = body.match(/AGENDA_URL\s*=\s*["']([^"']+)["']/);
      r.agenda_url_config = m ? m[1] : 'no encontrada';
    }
  } catch (e) { r.error = `${e.name}: ${e.message}`; }
  salida.push(r);
  console.log(JSON.stringify(r));
}
fs.writeFileSync('diag2_resultado.json', JSON.stringify({ ejecutado: new Date().toISOString(), salida }, null, 2));
