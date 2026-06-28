'use strict';

/**
 * Serveur Suricate (MVP-0).
 *
 * Pur Node.js (module http natif), sans framework ni dépendance, pour rester
 * immédiatement exécutable. Il expose :
 *   - une API REST sous /api/...
 *   - les fichiers statiques des deux interfaces (patient & médecin)
 *
 * Pour la production on passera derrière Express + un reverse-proxy HTTPS,
 * avec authentification forte. Ici l'objectif est de démontrer la boucle
 * fonctionnelle de bout en bout.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) reject(new Error('Corps de requête trop volumineux.'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('JSON invalide.'));
      }
    });
    req.on('error', reject);
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Découpe un scénario en phases situées dans le temps à partir de la date de
 * début du patient.
 */
function buildPhaseTimeline(startDate, scenario) {
  const t0 = new Date(startDate).getTime();
  const phases = (scenario && scenario.phases) || [];
  let cursor = t0;
  const intervals = phases.map((p) => {
    const start = cursor;
    const end = cursor + (Number(p.days) || 0) * DAY_MS;
    cursor = end;
    return { start, end, gabaritStart: p.gabaritStart, gabaritEnd: p.gabaritEnd };
  });
  return { t0, end: cursor, intervals };
}

// Seuil d'alerte interpolé à l'instant t (null si pas de seuil défini).
function ceilingAt(t, timeline) {
  const iv = timeline.intervals;
  if (!iv.length) return null;
  const interp = (p) => {
    if (p.gabaritStart == null || p.gabaritEnd == null) return null;
    const frac = p.end > p.start ? Math.max(0, Math.min(1, (t - p.start) / (p.end - p.start))) : 0;
    return p.gabaritStart + frac * (p.gabaritEnd - p.gabaritStart);
  };
  if (t <= iv[0].start) return iv[0].gabaritStart;
  const last = iv[iv.length - 1];
  if (t >= last.end) return last.gabaritEnd;
  for (const p of iv) if (t >= p.start && t < p.end) return interp(p);
  return last.gabaritEnd;
}

function envelopeFor(timeline) {
  const env = [];
  timeline.intervals.forEach((p) => {
    if (p.gabaritStart != null) env.push({ t: new Date(p.start).toISOString(), ceiling: p.gabaritStart });
    if (p.gabaritEnd != null) env.push({ t: new Date(p.end).toISOString(), ceiling: p.gabaritEnd });
  });
  return env;
}

// Série d'une métrique (douleur ou sommeil) selon SON scénario.
function seriesForMetric(patient, scenario, measurements) {
  const timeline = buildPhaseTimeline(
    patient.startDate,
    scenario || { phases: [] }
  );
  const points = measurements.map((m) => {
    const t = new Date(m.recordedAt).getTime();
    const ceiling = scenario ? ceilingAt(t, timeline) : null;
    const outOfBounds = ceiling != null && m.value > ceiling;
    return { t: m.recordedAt, value: m.value, ceiling, outOfBounds };
  });
  return {
    points,
    envelope: scenario ? envelopeFor(timeline) : [],
    scenario: scenario
      ? { id: scenario.id, name: scenario.name, metric: scenario.metric || 'pain', precision: scenario.precision || 0 }
      : null,
    timelineEnd: timeline.end,
  };
}

/**
 * Construit la série affichée par le médecin. Un patient peut avoir plusieurs
 * scénarios ; on en prend un par métrique (douleur / sommeil).
 */
function buildSeries(patient) {
  const scenarios = store.getScenarioIds(patient)
    .map((id) => store.getScenario(id))
    .filter(Boolean);
  const all = store.listMeasurements(patient.id);

  const findScn = (metric) => scenarios.find((s) => (s.metric || 'pain') === metric);
  const painScn = findScn('pain');
  const sleepScn = findScn('sleep');

  const pain = seriesForMetric(patient, painScn, all.filter((m) => m.type !== 'sleep'));
  const sleep = seriesForMetric(patient, sleepScn, all.filter((m) => m.type === 'sleep'));
  const alerts = pain.points.filter((p) => p.outOfBounds);

  // Axe temps global (couvre tous les scénarios + mesures débordantes).
  const t0 = new Date(patient.startDate).getTime();
  const times = all.map((m) => new Date(m.recordedAt).getTime());
  const ends = [pain.timelineEnd, sleep.timelineEnd].filter((v) => Number.isFinite(v));
  const start = Math.min(t0, ...(times.length ? times : [t0]));
  const end = Math.max(t0 + DAY_MS, ...ends, ...(times.length ? times : [t0]));

  return {
    patient,
    scenarios: scenarios.map((s) => ({
      id: s.id, name: s.name, metric: s.metric || 'pain',
      precision: s.precision || 0, phases: s.phases,
    })),
    timeline: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    pain: { points: pain.points, envelope: pain.envelope, scenario: pain.scenario },
    sleep: { points: sleep.points, envelope: sleep.envelope, scenario: sleep.scenario },
    alerts,
    alertActive: alerts.length > 0,
  };
}

// --- Routage de l'API ------------------------------------------------------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const seg = parts.slice(1); // sans 'api'
  const method = req.method;

  try {
    // /api/health
    if (seg[0] === 'health' && method === 'GET') {
      return sendJSON(res, 200, { ok: true, service: 'suricate', version: '0.4.0' });
    }

    // /api/scenarios
    if (seg[0] === 'scenarios' && seg.length === 1) {
      if (method === 'GET') return sendJSON(res, 200, store.listScenarios());
      if (method === 'POST') {
        const body = await readBody(req);
        return sendJSON(res, 201, store.createScenario(body));
      }
    }

    // /api/scenarios/:id  (édition d'un scénario existant)
    if (seg[0] === 'scenarios' && seg[1] && seg.length === 2) {
      if (method === 'GET') {
        const s = store.getScenario(seg[1]);
        return s ? sendJSON(res, 200, s) : sendJSON(res, 404, { error: 'Scénario introuvable.' });
      }
      if (method === 'PUT' || method === 'PATCH') {
        const body = await readBody(req);
        return sendJSON(res, 200, store.updateScenario(seg[1], body));
      }
    }

    // /api/patients
    if (seg[0] === 'patients' && seg.length === 1) {
      if (method === 'GET') return sendJSON(res, 200, store.listPatients());
      if (method === 'POST') {
        const body = await readBody(req);
        return sendJSON(res, 201, store.createPatient(body));
      }
    }

    // /api/patients/by-pseudo/:pseudo  (l'app patient se connecte par pseudo)
    if (seg[0] === 'patients' && seg[1] === 'by-pseudo' && seg[2] && method === 'GET') {
      const p = store.getPatientByPseudo(decodeURIComponent(seg[2]));
      if (!p) return sendJSON(res, 404, { error: 'Pseudo inconnu.' });
      const scenarios = store.getScenarioIds(p).map((id) => store.getScenario(id)).filter(Boolean);
      return sendJSON(res, 200, { patient: p, scenarios });
    }

    // /api/patients/:id ...
    if (seg[0] === 'patients' && seg[1] && seg[1] !== 'by-pseudo') {
      const patient = store.getPatient(seg[1]);
      if (!patient) return sendJSON(res, 404, { error: 'Patient introuvable.' });

      // /api/patients/:id
      if (seg.length === 2 && method === 'GET') return sendJSON(res, 200, patient);

      // /api/patients/:id/series  -> courbe + gabarit + alertes
      if (seg[2] === 'series' && method === 'GET') {
        return sendJSON(res, 200, buildSeries(patient));
      }

      // /api/patients/:id/measurements
      if (seg[2] === 'measurements') {
        if (method === 'GET') return sendJSON(res, 200, store.listMeasurements(patient.id));
        if (method === 'POST') {
          const body = await readBody(req);
          // Accepte soit une mesure unique, soit un lot (sync hors-ligne).
          const items = Array.isArray(body.items) ? body.items : [body];
          const saved = items.map((it) => store.addMeasurement(patient.id, it));
          return sendJSON(res, 201, { saved });
        }
      }
    }

    return sendJSON(res, 404, { error: 'Route inconnue.' });
  } catch (err) {
    return sendJSON(res, 400, { error: err.message || 'Erreur de traitement.' });
  }
}

// --- Fichiers statiques ----------------------------------------------------

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  // Empêche la traversée de répertoires
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || stat.isDirectory()) {
      // Repli SPA : sert l'index.html du dossier si présent
      const fallback = path.join(filePath, 'index.html');
      if (!err && stat.isDirectory() && fs.existsSync(fallback)) {
        return streamFile(res, fallback);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — fichier introuvable');
    }
    streamFile(res, filePath);
  });
}

function streamFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// --- Serveur ---------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  serveStatic(req, res, url);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  Suricate MVP-0 en écoute sur http://localhost:${PORT}`);
    console.log(`  • Patient  : http://localhost:${PORT}/patient/`);
    console.log(`  • Médecin  : http://localhost:${PORT}/doctor/\n`);
  });
}

module.exports = { server, buildSeries };
