# json — Agenda combinada (lector-agendas)

Este repositorio mantiene `agenda_combinada.json`, el archivo que consume la app (`app.apk`)
desde:

```
https://raw.githubusercontent.com/belkaperu/json/main/agenda_combinada.json
```

Un robot de GitHub Actions (`.github/workflows/actualizar_agenda.yml`) ejecuta `index.js`
cada 10 minutos, descarga la agenda del día desde `agenda18.com`, le inyecta canales extra
(Megadeportes, si responde) y sube el JSON actualizado.

Estructura del archivo (la app depende de ella, **no cambiar**):

```json
{ "data": [ { "id": 1, "attributes": { "diary_description": "...", "diary_hour": "19:00:00", "date_diary": "2026-11-25", "embeds": { "data": [] } } } ],
  "meta": { "pagination": { "page": 1, "pageSize": 21, "pageCount": 1, "total": 21 } } }
```

---

## Por qué la agenda dejó de actualizarse (25-nov-2026)

Síntomas: `agenda_combinada.json` se quedó con los 6 partidos del **24-nov**, mientras
`agenda18.com/agenda.json` ya publicaba 21 partidos del **25-nov**. El workflow salía en verde.

Causas encontradas (con el diagnóstico ejecutado desde un runner de GitHub):

1. **La fuente sólo publica el día en curso.** A las 11:20 UTC (última corrida) `agenda18.com`
   todavía no tenía los partidos de hoy: se publicaron recién a las **17:01 UTC**. Es decir, la
   agenda del 25-nov no existía cuando corrió el robot. Esto se repetía todos los días, y la
   agenda quedaba con la fecha de ayer durante horas.
2. **El robot corría 1 vez cada ~7 horas, no cada 15 minutos.** GitHub descarta/retrasa la gran
   mayoría de las ejecuciones del `cron: '*/15 * * * *'`: medido sobre las últimas 98 corridas,
   el intervalo real fue de 3,5 a 11,7 horas (mediana ≈ 7 h). Con esa frecuencia casi nunca
   caía en la ventana en la que la fuente ya tiene los partidos del día.
3. **Los fallos eran silenciosos.** `index.js` hacía `return` dentro de un `catch` y nunca
   marcaba error: si la descarga fallaba, el proceso terminaba con código 0 (el workflow salía
   "success") y el JSON viejo quedaba intacto. Además el paso de Git usaba
   `git pull --rebase origin main`, así que en cualquier rama que no fuera `main` habría hecho
   push de la agenda a `main` desde una rama de trabajo.
4. **`.github/workflows/main.yml` no era un workflow válido** (empezaba con un paso suelto,
   sin `name:`/`on:`/`jobs:`), así que aparecía siempre como ejecución fallida y no aportaba nada.

## Qué se corrigió

`index.js`

- Reintentos (3) con espera progresiva y protección contra respuestas cacheadas (`_=<timestamp>`).
- Lista de fuentes con respaldo: `config.js` (si responde) → `agenda.json?v=1.12` → `agenda.json`.
- Validación de la respuesta: debe ser JSON con array `data`; si llega HTML, vacío o un error
  HTTP, se reintenta y se pasa a la siguiente fuente.
- Si la fuente responde una agenda **vacía válida**, se escribe vacía (la app muestra "sin
  partidos") en lugar de dejar pegados los partidos del día anterior.
- Si la fuente falla del todo, se conserva el archivo anterior y el proceso termina con
  **código 1** (falla visible en Actions).
- Si la fuente devuelve una agenda **más vieja** que la guardada, no se sobreescribe.
- Se conserva exactamente la estructura `{ data, meta.pagination }` que consume la app.
- Megadeportes ya no puede romper el proceso y los canales duplicados no se vuelven a insertar.

`.github/workflows/actualizar_agenda.yml`

- `cron: '*/10 * * * *'` (más oportunidades reales de ejecución), `timeout-minutes: 10`,
  `concurrency` para no solapar corridas.
- `permissions: contents: write` explícito.
- Push con 3 reintentos y `HEAD:$RAMA_DESTINO` (nunca escribe en `main` desde una rama de trabajo).
- Se agregó `repository_dispatch` (tipo `actualizar-agenda`) para poder forzar la actualización
  desde un cron externo si GitHub sigue saltándose ejecuciones.
- Se eliminó `main.yml` (workflow inválido).

## Forzar una actualización ahora

- Desde la web: **Actions → Actualizador de Agenda Automático → Run workflow**.
- Desde un cron externo (cron-job.org, etc.), cada 10 minutos:

```bash
curl -X POST https://api.github.com/repos/belkaperu/json/dispatches \
  -H "Authorization: Bearer <token_con_scope_repo>" \
  -H "Accept: application/vnd.github+json" \
  -d '{"event_type":"actualizar-agenda"}'
```

## Nota sobre las cachés

La app descarga el JSON desde `raw.githubusercontent.com`, que cachea ~5 minutos. Si tras una
actualización la app sigue mostrando lo anterior, esperar unos minutos o abrir/cerrar la app.

## Pruebas locales

```bash
npm install
AGENDA_ARCHIVO=/tmp/salida.json \
AGENDA_URL=http://127.0.0.1:8099/agenda.json \
CONFIG_URL=http://127.0.0.1:8099/config.js \
MEGADEPORTES_URL=http://127.0.0.1:8099/nada \
node index.js
```

Variables opcionales (sólo para pruebas): `AGENDA_URL`, `CONFIG_URL`, `MEGADEPORTES_URL`,
`AGENDA_ARCHIVO`. En producción no se define ninguna y se usan las URLs reales.
