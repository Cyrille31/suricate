'use strict';

/* Serveur Suricate (MVP) — pur Node.js, API REST + fichiers statiques. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = '0.8.2';
const DAY_MS = 24 * 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webmanifest': 'application/manifest+json',
};

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5e6) reject(new Error('Corps trop volumineux.')); });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON invalide.')); } });
    req.on('error', reject);
  });
}

// --- Calcul des séries -----------------------------------------------------

function buildPhaseTimeline(startDate, scenario) {
  const offset = (scenario && scenario.startOffsetMinutes ? scenario.startOffsetMinutes : 0) * 60000;
  const t0 = new Date(startDate).getTime() + offset;
  const phases = (scenario && scenario.phases) || [];
  let cursor = t0;
  const intervals = phases.map((p) => {
    const start = cursor; const end = cursor + (Number(p.days) || 0) * DAY_MS; cursor = end;
    return { start, end, gabaritStart: p.gabaritStart, gabaritEnd: p.gabaritEnd };
  });
  return { t0, end: cursor, intervals };
}
function ceilingAt(t, timeline) {
  const iv = timeline.intervals;
  if (!iv.length) return null;
  const interp = (p) => {
    if (p.gabaritStart == null || p.gabaritEnd == null) return null;
    const f = p.end > p.start ? Math.max(0, Math.min(1, (t - p.start) / (p.end - p.start))) : 0;
    return p.gabaritStart + f * (p.gabaritEnd - p.gabaritStart);
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

// Créneaux attendus (déduits des phases) jusqu'à `until`. tol = fenêtre où une
// mesure est considérée "à l'heure" (sinon elle est spontanée / le créneau manqué).
function scheduledTimes(startDate, scenario, until) {
  const offset = (scenario && scenario.startOffsetMinutes ? scenario.startOffsetMinutes : 0) * 60000;
  let cursor = new Date(startDate).getTime() + offset;
  const out = [];
  for (const p of ((scenario && scenario.phases) || [])) {
    const phaseEnd = cursor + (Number(p.days) || 0) * DAY_MS;
    const step = (Number(p.frequencyMinutes) || 0) * 60000;
    if (step > 0) for (let t = cursor; t < phaseEnd; t += step) { if (t <= until) out.push({ t, tol: Math.min(step * 0.3, 2 * 3600 * 1000) }); }
    cursor = phaseEnd;
  }
  return out;
}
function interpolate(sorted, t) {
  if (!sorted.length) return null;
  if (t <= sorted[0].t) return sorted[0].v;
  const last = sorted[sorted.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 1; i < sorted.length; i++) {
    if (t <= sorted[i].t) { const a = sorted[i - 1], b = sorted[i]; const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0; return a.v + f * (b.v - a.v); }
  }
  return last.v;
}
function seriesForMetric(startDate, scenario, measurements) {
  const timeline = buildPhaseTimeline(startDate, scenario || { phases: [] });
  const sorted = measurements.map((m) => ({ t: new Date(m.recordedAt).getTime(), v: m.value, m })).sort((a, b) => a.t - b.t);

  const until = Math.min(timeline.end, Date.now());
  const slots = scenario ? scheduledTimes(startDate, scenario, until) : [];
  const answered = new Array(slots.length).fill(false);
  const scheduledMeas = new Set();
  sorted.forEach((pt, mi) => {
    let best = -1, bestD = Infinity;
    slots.forEach((s, si) => { const d = Math.abs(pt.t - s.t); if (d <= s.tol && d < bestD) { bestD = d; best = si; } });
    if (best >= 0) answered[best] = true; // créneau couvert par une mesure (toute origine) -> pas "manqué"
    const src = pt.m.source;
    if (src === 'scheduled') scheduledMeas.add(mi);
    else if (src === 'spontaneous') { /* reste spontané */ }
    else if (best >= 0) scheduledMeas.add(mi); // sans drapeau : on déduit du planning
  });

  const points = sorted.map((pt, mi) => {
    const ceiling = scenario ? ceilingAt(pt.t, timeline) : null;
    return { t: pt.m.recordedAt, value: pt.v, ceiling, outOfBounds: ceiling != null && pt.v > ceiling, kind: scheduledMeas.has(mi) ? 'scheduled' : 'spontaneous' };
  });

  const missed = [];
  if (sorted.length >= 2) {
    const first = sorted[0].t, last = sorted[sorted.length - 1].t;
    slots.forEach((s, si) => {
      if (!answered[si] && s.t > first && s.t < last) {
        const v = interpolate(sorted, s.t);
        const ceiling = scenario ? ceilingAt(s.t, timeline) : null;
        missed.push({ t: new Date(s.t).toISOString(), value: Math.round(v * 100) / 100, ceiling, interpolated: true });
      }
    });
  }

  return {
    points, missed,
    envelope: scenario ? envelopeFor(timeline) : [],
    scenario: scenario ? { id: scenario.id, name: scenario.name, metric: scenario.metric || 'pain', precision: scenario.precision || 0 } : null,
    timelineEnd: timeline.end,
  };
}

function buildSeries(intervention) {
  const patient = store.getPatient(intervention.patientId);
  const scenarios = store.getScenarioIds(intervention).map((id) => store.getScenario(id)).filter(Boolean);
  const all = store.listMeasurements(intervention.id);
  const findScn = (metric) => scenarios.find((s) => (s.metric || 'pain') === metric);
  const painScn = findScn('pain'), sleepScn = findScn('sleep');

  const pain = seriesForMetric(intervention.startDate, painScn, all.filter((m) => m.type !== 'sleep'));
  const sleep = seriesForMetric(intervention.startDate, sleepScn, all.filter((m) => m.type === 'sleep'));
  const alerts = pain.points.filter((p) => p.outOfBounds);

  const t0 = new Date(intervention.startDate).getTime();
  const times = all.map((m) => new Date(m.recordedAt).getTime());
  const ends = [pain.timelineEnd, sleep.timelineEnd].filter((v) => Number.isFinite(v));
  const start = Math.min(t0, ...(times.length ? times : [t0]));
  const end = Math.max(t0 + DAY_MS, ...ends, ...(times.length ? times : [t0]));

  return {
    intervention,
    patient: patient ? { id: patient.id, pseudo: patient.pseudo, sex: patient.sex, ageRange: patient.ageRange } : null,
    scenarios: scenarios.map((s) => ({ id: s.id, name: s.name, metric: s.metric || 'pain', precision: s.precision || 0 })),
    timeline: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    pain: { points: pain.points, missed: pain.missed, envelope: pain.envelope, scenario: pain.scenario },
    sleep: { points: sleep.points, missed: sleep.missed, envelope: sleep.envelope, scenario: sleep.scenario },
    alerts, alertActive: alerts.length > 0,
  };
}

// --- Routage API -----------------------------------------------------------

async function handleApi(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean).slice(1); // sans 'api'
  const m = req.method;
  try {
    if (seg[0] === 'health' && m === 'GET') return sendJSON(res, 200, { ok: true, service: 'suricate', version: VERSION });

    // Scénarios
    if (seg[0] === 'scenarios' && seg.length === 1) {
      if (m === 'GET') return sendJSON(res, 200, store.listScenarios());
      if (m === 'POST') return sendJSON(res, 201, store.createScenario(await readBody(req)));
    }
    if (seg[0] === 'scenarios' && seg[1] && seg.length === 2) {
      if (m === 'GET') { const s = store.getScenario(seg[1]); return s ? sendJSON(res, 200, s) : sendJSON(res, 404, { error: 'Scénario introuvable.' }); }
      if (m === 'PUT' || m === 'PATCH') return sendJSON(res, 200, store.updateScenario(seg[1], await readBody(req)));
    }

    // Patients (personnes)
    if (seg[0] === 'patients' && seg.length === 1) {
      if (m === 'GET') return sendJSON(res, 200, store.listPatients());
      if (m === 'POST') return sendJSON(res, 201, store.createPatient(await readBody(req)));
    }
    if (seg[0] === 'patients' && seg[1] && seg.length === 2 && m === 'GET') {
      const p = store.getPatient(seg[1]); return p ? sendJSON(res, 200, p) : sendJSON(res, 404, { error: 'Patient introuvable.' });
    }
    if (seg[0] === 'patients' && seg[1] && seg[2] === 'interventions' && m === 'GET') {
      return sendJSON(res, 200, store.listInterventionsByPatient(seg[1]));
    }

    // Interventions
    if (seg[0] === 'interventions' && seg.length === 1) {
      if (m === 'GET') return sendJSON(res, 200, store.listInterventions());
      if (m === 'POST') return sendJSON(res, 201, store.createIntervention(await readBody(req)));
    }
    if (seg[0] === 'interventions' && seg[1] === 'by-pseudo' && seg[2] && m === 'GET') {
      const itv = store.getInterventionByPseudo(decodeURIComponent(seg[2]));
      if (!itv) return sendJSON(res, 404, { error: 'Pseudo inconnu.' });
      const patient = store.getPatient(itv.patientId);
      const scenarios = store.getScenarioIds(itv).map((id) => store.getScenario(id)).filter(Boolean);
      return sendJSON(res, 200, {
        intervention: itv,
        patient: patient ? { id: patient.id, pseudo: patient.pseudo } : null,
        scenarios,
      });
    }
    if (seg[0] === 'interventions' && seg[1] && seg[1] !== 'by-pseudo') {
      const itv = store.getIntervention(seg[1]);
      if (!itv) return sendJSON(res, 404, { error: 'Intervention introuvable.' });
      if (seg.length === 2 && m === 'GET') return sendJSON(res, 200, itv);
      if (seg[2] === 'series' && m === 'GET') return sendJSON(res, 200, buildSeries(itv));
      if (seg[2] === 'measurements') {
        if (m === 'GET') return sendJSON(res, 200, store.listMeasurements(itv.id));
        if (m === 'POST') {
          const body = await readBody(req);
          const items = Array.isArray(body.items) ? body.items : [body];
          return sendJSON(res, 201, { saved: items.map((it) => store.addMeasurement(itv.id, it)) });
        }
      }
    }

    // Administration (jeu de test) — active uniquement si ADMIN_TOKEN est défini.
    if (seg[0] === 'admin' && (m === 'POST')) {
      if (!process.env.ADMIN_TOKEN || req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return sendJSON(res, 403, { error: 'Jeton d\'administration invalide.' });
      if (seg[1] === 'reset') { await store.reset(); return sendJSON(res, 200, { ok: true, reset: true }); }
      if (seg[1] === 'seed-demo') {
        await store.reset();
        require('./seed-demo').seedDemo();
        await store.flush();
        return sendJSON(res, 200, { ok: true, patients: store.listPatients().length, interventions: store.listInterventions().length });
      }
    }

    return sendJSON(res, 404, { error: 'Route inconnue.' });
  } catch (e) {
    return sendJSON(res, 400, { error: e.message || 'Erreur de traitement.' });
  }
}

// --- Fichiers statiques ----------------------------------------------------

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      // /patient -> /patient/ : sans le slash final, les liens relatifs
      // (style.css, app.js, manifest) sont résolus à la racine et échouent.
      if (!url.pathname.endsWith('/')) {
        res.writeHead(302, { Location: `${url.pathname}/${url.search || ''}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      const fallback = path.join(filePath, 'index.html');
      if (fs.existsSync(fallback)) return streamFile(res, fallback);
    }
    if (err || stat.isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — fichier introuvable');
    }
    streamFile(res, filePath);
  });
}
function streamFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  serveStatic(req, res, url);
});

if (require.main === module) {
  store.init()
    .then(() => server.listen(PORT, () => {
      console.log(`\n  Suricate ${VERSION} en écoute sur http://localhost:${PORT}`);
      console.log(`  • Patient  : http://localhost:${PORT}/patient/`);
      console.log(`  • Médecin  : http://localhost:${PORT}/doctor/`);
      console.log(`  • Stockage : ${store._internal.CLOUD ? 'base cloud (KV)' : 'fichier local'}\n`);
    }))
    .catch((e) => { console.error('Erreur d\'initialisation de la base :', e.message); process.exit(1); });
}
module.exports = { server, buildSeries };
