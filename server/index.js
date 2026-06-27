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

/**
 * Construit la série affichée par le médecin : points de douleur, enveloppe
 * (gabarit) du scénario, et liste des points hors-gabarit (= alertes).
 */
function buildSeries(patient) {
  const scenario = store.getScenario(patient.scenarioId);
  const gabarit = scenario ? scenario.gabarit : { min: 0, max: 10 };
  const points = store.listMeasurements(patient.id).map((m) => {
    const outOfBounds = m.value < gabarit.min || m.value > gabarit.max;
    return { t: m.recordedAt, value: m.value, outOfBounds };
  });
  const alerts = points.filter((p) => p.outOfBounds);
  return {
    patient,
    scenario: scenario
      ? { id: scenario.id, name: scenario.name, phases: scenario.phases }
      : null,
    gabarit,
    points,
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
      return sendJSON(res, 200, { ok: true, service: 'suricate', version: '0.1.0' });
    }

    // /api/scenarios
    if (seg[0] === 'scenarios' && seg.length === 1) {
      if (method === 'GET') return sendJSON(res, 200, store.listScenarios());
      if (method === 'POST') {
        const body = await readBody(req);
        return sendJSON(res, 201, store.createScenario(body));
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
      const scenario = store.getScenario(p.scenarioId);
      return sendJSON(res, 200, { patient: p, scenario });
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
