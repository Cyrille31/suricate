'use strict';

/* Test de fumée : démarre le serveur, exerce l'API de bout en bout et
   vérifie la détection d'alerte hors-gabarit. Lancer : npm test
   Utilise une base temporaire pour ne pas toucher aux données réelles. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Base de test isolée
const TEST_DB = path.join(__dirname, '..', 'server', 'data', 'db.json');
const BACKUP = TEST_DB + '.bak';
if (fs.existsSync(TEST_DB)) fs.renameSync(TEST_DB, BACKUP);

function restore() {
  if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
  if (fs.existsSync(BACKUP)) fs.renameSync(BACKUP, TEST_DB);
}

const { server } = require('../server/index');
let base;

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + pathname, {
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  // health
  let r = await req('GET', '/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);

  // créer un scénario
  r = await req('POST', '/api/scenarios', {
    name: 'Test scénario', gabarit: { min: 0, max: 5 },
    phases: [{ label: 'P1', days: 3, frequencyMinutes: 240 }],
  });
  assert.strictEqual(r.status, 201);
  const scenarioId = r.body.id;
  assert.ok(scenarioId);

  // créer un patient
  r = await req('POST', '/api/patients', { pseudo: 'test-007', scenarioId });
  assert.strictEqual(r.status, 201);
  const patientId = r.body.id;
  assert.strictEqual(r.body.pseudo, 'test-007');
  assert.ok(!('name' in r.body), 'le serveur ne doit jamais stocker de nom');

  // refus pseudo en double
  r = await req('POST', '/api/patients', { pseudo: 'test-007', scenarioId });
  assert.strictEqual(r.status, 400);

  // ajouter des mesures dont une hors-gabarit (8 > 5)
  r = await req('POST', `/api/patients/${patientId}/measurements`, {
    items: [
      { clientId: 'a', value: 2, recordedAt: '2024-01-01T08:00:00Z' },
      { clientId: 'b', value: 8, recordedAt: '2024-01-01T16:00:00Z' },
    ],
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.saved.length, 2);

  // idempotence : renvoyer 'a' ne crée pas de doublon
  r = await req('POST', `/api/patients/${patientId}/measurements`, {
    clientId: 'a', value: 2, recordedAt: '2024-01-01T08:00:00Z',
  });
  assert.strictEqual(r.status, 201);

  // valeur invalide rejetée
  r = await req('POST', `/api/patients/${patientId}/measurements`, { clientId: 'z', value: 42 });
  assert.strictEqual(r.status, 400);

  // série + détection d'alerte
  r = await req('GET', `/api/patients/${patientId}/series`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.points.length, 2, 'idempotence : toujours 2 points');
  assert.strictEqual(r.body.alertActive, true);
  assert.strictEqual(r.body.alerts.length, 1);
  assert.strictEqual(r.body.alerts[0].value, 8);

  console.log('✓ Tous les tests de fumée passent.');
}

server.listen(0, async () => {
  base = `http://localhost:${server.address().port}`;
  try {
    await run();
    server.close();
    restore();
    process.exit(0);
  } catch (err) {
    console.error('✗ Échec du test :', err.message);
    server.close();
    restore();
    process.exit(1);
  }
});
