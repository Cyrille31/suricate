'use strict';

/* Test de fumée : modèle patient/intervention, multi-scénarios, décalage de
   démarrage, gabarit variable, idempotence. Lancer : npm test */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TEST_DB = path.join(__dirname, '..', 'server', 'data', 'db.json');
const BACKUP = TEST_DB + '.bak';
if (fs.existsSync(TEST_DB)) fs.renameSync(TEST_DB, BACKUP);
const restore = () => { if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB); if (fs.existsSync(BACKUP)) fs.renameSync(BACKUP, TEST_DB); };

const { server } = require('../server/index');
let base;
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(base + p, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let raw = ''; res.on('data', (c) => (raw += c)); res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

async function run() {
  let r = await req('GET', '/api/health'); assert.strictEqual(r.body.ok, true);

  // Scénarios
  r = await req('POST', '/api/scenarios', { name: 'Douleur', metric: 'pain', precision: 1, phases: [{ label: 'P1', days: 10, frequencyMinutes: 240, gabaritStart: 5, gabaritEnd: 5 }] });
  const painScn = r.body.id; assert.strictEqual(r.body.metric, 'pain');
  r = await req('POST', '/api/scenarios', { name: 'Sommeil', metric: 'sleep', precision: 0, phases: [{ label: 'S', days: 14, frequencyMinutes: 1440 }] });
  const sleepScn = r.body.id; assert.strictEqual(r.body.phases[0].gabaritStart, null);

  // Patient (personne)
  r = await req('POST', '/api/patients', { sex: 'F', ageRange: '60-69' });
  assert.strictEqual(r.status, 201); const patId = r.body.id; assert.ok(r.body.pseudo);
  assert.ok(!('name' in r.body), 'pas d\'identité sur le serveur');

  // Intervention
  r = await req('POST', '/api/interventions', { patientId: patId, pseudo: 'HAN-1', operation: 'Prothèse de hanche', startDate: '2024-01-01T00:00:00Z', scenarioIds: [painScn, sleepScn] });
  assert.strictEqual(r.status, 201); const itvId = r.body.id;
  r = await req('POST', '/api/interventions', { patientId: patId, pseudo: 'HAN-1', scenarioIds: [painScn] });
  assert.strictEqual(r.status, 400, 'pseudo intervention en double refusé');

  // Connexion patient (app) -> intervention + scénarios
  r = await req('GET', '/api/interventions/by-pseudo/HAN-1');
  assert.strictEqual(r.body.scenarios.length, 2);

  // Mesures
  r = await req('POST', `/api/interventions/${itvId}/measurements`, { items: [
    { clientId: 'a', type: 'pain', value: 2.5, recordedAt: '2024-01-01T08:00:00Z' },
    { clientId: 'b', type: 'pain', value: 8.5, recordedAt: '2024-01-01T16:00:00Z' },
    { clientId: 'c', type: 'sleep', value: 7, recordedAt: '2024-01-01T07:00:00Z' },
  ] });
  assert.strictEqual(r.body.saved.length, 3);
  r = await req('POST', `/api/interventions/${itvId}/measurements`, { clientId: 'a', type: 'pain', value: 2.5 });
  assert.strictEqual(r.status, 201); // idempotent
  r = await req('POST', `/api/interventions/${itvId}/measurements`, { clientId: 'z', value: 42 });
  assert.strictEqual(r.status, 400);

  r = await req('GET', `/api/interventions/${itvId}/series`);
  assert.strictEqual(r.body.pain.points.length, 2);
  assert.strictEqual(r.body.sleep.points.length, 1);
  assert.strictEqual(r.body.alertActive, true);
  assert.strictEqual(r.body.alerts[0].value, 8.5);
  assert.strictEqual(r.body.pain.scenario.precision, 1);

  // Multi-intervention pour un même patient
  r = await req('POST', '/api/interventions', { patientId: patId, pseudo: 'GEN-1', operation: 'Prothèse de genou', startDate: '2024-03-01T00:00:00Z', scenarioIds: [painScn] });
  assert.strictEqual(r.status, 201);
  r = await req('GET', `/api/patients/${patId}/interventions`);
  assert.strictEqual(r.body.length, 2, 'patient déjà suivi = 2 interventions');

  // Décalage de démarrage : phase 8->2 sur 10 j, décalée de 5 j.
  r = await req('POST', '/api/scenarios', { name: 'Décalé', metric: 'pain', precision: 0, startOffsetMinutes: 5 * 1440, phases: [{ label: 'P', days: 10, frequencyMinutes: 240, gabaritStart: 8, gabaritEnd: 2 }] });
  const offScn = r.body.id; assert.strictEqual(r.body.startOffsetMinutes, 7200);
  r = await req('POST', '/api/patients', {}); const pat2 = r.body.id;
  r = await req('POST', '/api/interventions', { patientId: pat2, pseudo: 'OFF-1', startDate: '2024-01-01T00:00:00Z', scenarioIds: [offScn] });
  const itv2 = r.body.id;
  await req('POST', `/api/interventions/${itv2}/measurements`, { items: [
    { clientId: 'o1', type: 'pain', value: 7, recordedAt: '2024-01-07T00:00:00Z' }, // J+6 = J+1 de phase -> seuil ~7,4 -> OK
    { clientId: 'o2', type: 'pain', value: 6, recordedAt: '2024-01-15T00:00:00Z' }, // J+14 = J+9 de phase -> seuil ~2,6 -> ALERTE
  ] });
  r = await req('GET', `/api/interventions/${itv2}/series`);
  assert.strictEqual(r.body.pain.points[0].outOfBounds, false, 'décalage respecté (J+1 de phase)');
  assert.strictEqual(r.body.pain.points[1].outOfBounds, true, 'fin de phase -> alerte');

  // Planning : créneaux honorés / manqués (interpolés) / spontanés.
  r = await req('POST', '/api/scenarios', { name: 'Planning', metric: 'pain', precision: 0, phases: [{ label: 'P', days: 4, frequencyMinutes: 1440, gabaritStart: 9, gabaritEnd: 9 }] });
  const schScn = r.body.id;
  r = await req('POST', '/api/patients', {}); const pat3 = r.body.id;
  r = await req('POST', '/api/interventions', { patientId: pat3, pseudo: 'SCH-1', startDate: '2024-01-01T00:00:00Z', scenarioIds: [schScn] });
  const itv3 = r.body.id;
  await req('POST', `/api/interventions/${itv3}/measurements`, { items: [
    { clientId: 's0', type: 'pain', value: 8, recordedAt: '2024-01-01T00:00:00Z' }, // créneau J0
    { clientId: 'sp', type: 'pain', value: 5, recordedAt: '2024-01-02T12:00:00Z' }, // hors créneau -> spontané
    { clientId: 's2', type: 'pain', value: 4, recordedAt: '2024-01-03T00:00:00Z' }, // créneau J2
  ] });
  r = await req('GET', `/api/interventions/${itv3}/series`);
  const pp = r.body.pain.points;
  assert.strictEqual(pp.length, 3);
  assert.strictEqual(pp[0].kind, 'scheduled');
  assert.strictEqual(pp[1].kind, 'spontaneous');
  assert.strictEqual(pp[2].kind, 'scheduled');
  assert.strictEqual(r.body.pain.missed.length, 1, 'créneau J1 manqué entre les mesures');
  assert.ok(Math.abs(r.body.pain.missed[0].value - 6) < 0.01, 'valeur interpolée ≈ 6');

  // Drapeau "spontané" prioritaire sur le timing (même posé sur un créneau).
  r = await req('POST', '/api/patients', {}); const pat4 = r.body.id;
  r = await req('POST', '/api/interventions', { patientId: pat4, pseudo: 'SCH-2', startDate: '2024-01-01T00:00:00Z', scenarioIds: [schScn] });
  const itv4 = r.body.id;
  await req('POST', `/api/interventions/${itv4}/measurements`, { items: [
    { clientId: 'f0', type: 'pain', value: 7, recordedAt: '2024-01-01T00:00:00Z', source: 'spontaneous' }, // sur le créneau J0 mais déclaré spontané
    { clientId: 'f2', type: 'pain', value: 4, recordedAt: '2024-01-03T00:00:00Z' },                          // créneau J2 (déduit)
  ] });
  r = await req('GET', `/api/interventions/${itv4}/series`);
  assert.strictEqual(r.body.pain.points[0].kind, 'spontaneous', 'drapeau spontané respecté');
  assert.strictEqual(r.body.pain.points[1].kind, 'scheduled');
  assert.strictEqual(r.body.pain.missed.length, 1, 'le créneau J0 couvert n\'est pas manqué');

  // Édition scénario
  r = await req('PUT', `/api/scenarios/${painScn}`, { precision: 2 });
  assert.strictEqual(r.body.precision, 2);

  console.log('✓ Tous les tests de fumée passent.');
}

server.listen(0, async () => {
  base = `http://localhost:${server.address().port}`;
  try { await run(); server.close(); restore(); process.exit(0); }
  catch (e) { console.error('✗ Échec :', e.message, '\n', e.stack); server.close(); restore(); process.exit(1); }
});
