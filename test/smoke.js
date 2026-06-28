'use strict';

/* Test de fumée : modèle multi-scénarios (une métrique par scénario),
   précision décimale, seuils optionnels & variables, édition de scénario,
   idempotence de la synchro. Lancer : npm test (base temporaire). */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, '..', 'server', 'data', 'db.json');
const BACKUP = TEST_DB + '.bak';
if (fs.existsSync(TEST_DB)) fs.renameSync(TEST_DB, BACKUP);
function restore() {
  if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
  if (fs.existsSync(BACKUP)) fs.renameSync(BACKUP, TEST_DB);
}

const { server } = require('../server/index');
let base;
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let raw = ''; res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

async function run() {
  let r = await req('GET', '/api/health');
  assert.strictEqual(r.body.ok, true);

  // Scénario DOULEUR (précision 1, seuil constant 5).
  r = await req('POST', '/api/scenarios', {
    name: 'Douleur test', metric: 'pain', precision: 1,
    phases: [{ label: 'P1', days: 10, frequencyMinutes: 240, gabaritStart: 5, gabaritEnd: 5 }],
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.metric, 'pain');
  assert.strictEqual(r.body.precision, 1);
  const painScn = r.body.id;

  // Scénario SOMMEIL (précision 0, sans seuil).
  r = await req('POST', '/api/scenarios', {
    name: 'Sommeil test', metric: 'sleep', precision: 0,
    phases: [{ label: 'S1', days: 14, frequencyMinutes: 1440 }],
  });
  assert.strictEqual(r.body.metric, 'sleep');
  assert.strictEqual(r.body.phases[0].gabaritStart, null, 'pas de seuil sur le sommeil');
  const sleepScn = r.body.id;

  // Patient abonné aux DEUX scénarios.
  r = await req('POST', '/api/patients', {
    pseudo: 'multi-007', scenarioIds: [painScn, sleepScn], startDate: '2024-01-01T00:00:00Z',
  });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(r.body.scenarioIds, [painScn, sleepScn]);
  assert.ok(!('name' in r.body));
  const pid = r.body.id;

  // Au moins un scénario requis.
  r = await req('POST', '/api/patients', { pseudo: 'x', scenarioIds: [] });
  assert.strictEqual(r.status, 400);

  // Connexion patient -> renvoie les 2 scénarios.
  r = await req('GET', '/api/patients/by-pseudo/multi-007');
  assert.strictEqual(r.body.scenarios.length, 2);

  // Mesures décimales : douleur 2.5 (ok) et 8.5 (> seuil 5 -> alerte) + sommeil 7.
  r = await req('POST', `/api/patients/${pid}/measurements`, {
    items: [
      { clientId: 'a', type: 'pain', value: 2.5, recordedAt: '2024-01-01T08:00:00Z' },
      { clientId: 'b', type: 'pain', value: 8.5, recordedAt: '2024-01-01T16:00:00Z' },
      { clientId: 'c', type: 'sleep', value: 7, recordedAt: '2024-01-01T07:00:00Z' },
    ],
  });
  assert.strictEqual(r.body.saved.length, 3);

  // Idempotence.
  r = await req('POST', `/api/patients/${pid}/measurements`, { clientId: 'a', type: 'pain', value: 2.5 });
  assert.strictEqual(r.status, 201);

  // Valeur invalide.
  r = await req('POST', `/api/patients/${pid}/measurements`, { clientId: 'z', value: 42 });
  assert.strictEqual(r.status, 400);

  // Série : douleur + sommeil séparés, alerte sur la douleur.
  r = await req('GET', `/api/patients/${pid}/series`);
  assert.strictEqual(r.body.pain.points.length, 2);
  assert.strictEqual(r.body.sleep.points.length, 1);
  assert.strictEqual(r.body.pain.scenario.precision, 1);
  assert.strictEqual(r.body.sleep.scenario.metric, 'sleep');
  assert.strictEqual(r.body.alertActive, true);
  assert.strictEqual(r.body.alerts[0].value, 8.5);
  assert.strictEqual(r.body.sleep.envelope.length, 0, 'sommeil sans enveloppe');

  // Édition de scénario (PUT) : passe la précision à 2.
  r = await req('PUT', `/api/scenarios/${painScn}`, { precision: 2 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.precision, 2);
  r = await req('GET', `/api/scenarios/${painScn}`);
  assert.strictEqual(r.body.precision, 2);

  // Gabarit VARIABLE : 8 -> 2 sur 10 jours. J+1 OK, J+6 alerte.
  r = await req('POST', '/api/scenarios', {
    name: 'Pente', metric: 'pain', precision: 0,
    phases: [{ label: 'P', days: 10, frequencyMinutes: 240, gabaritStart: 8, gabaritEnd: 2 }],
  });
  const scn2 = r.body.id;
  r = await req('POST', '/api/patients', { pseudo: 'pente-1', scenarioIds: [scn2], startDate: '2024-01-01T00:00:00Z' });
  const pat2 = r.body.id;
  await req('POST', `/api/patients/${pat2}/measurements`, {
    items: [
      { clientId: 'p1', type: 'pain', value: 6, recordedAt: '2024-01-02T00:00:00Z' },
      { clientId: 'p2', type: 'pain', value: 6, recordedAt: '2024-01-07T00:00:00Z' },
    ],
  });
  r = await req('GET', `/api/patients/${pat2}/series`);
  assert.strictEqual(r.body.pain.points[0].outOfBounds, false);
  assert.strictEqual(r.body.pain.points[1].outOfBounds, true);

  console.log('✓ Tous les tests de fumée passent.');
}

server.listen(0, async () => {
  base = `http://localhost:${server.address().port}`;
  try { await run(); server.close(); restore(); process.exit(0); }
  catch (err) { console.error('✗ Échec du test :', err.message, '\n', err.stack); server.close(); restore(); process.exit(1); }
});
