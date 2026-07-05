'use strict';

/**
 * Jeu de test : 10 scénarios, ~17 patients, 20 interventions (dont 3 patients
 * ayant DÉJÀ été suivis = 2 interventions), mesures alignées sur les créneaux (avec créneaux manqués + saisies spontanées).
 * Pseudo d'intervention = code opération + n° (HAN-1, CES-2, …).
 * Lancer : npm run reset && npm run seed:demo
 */

const store = require('./store');

let _seed = 424242;
const rnd = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };
const rint = (a, b) => Math.floor(a + rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const round = (v, p) => { const f = Math.pow(10, p); return Math.round(v * f) / f; };
const clip = (v) => Math.max(0, Math.min(10, v));

const PAIN = [
  { abbr: 'HAN', op: 'Prothèse de hanche', count: 4, precision: 1, ages: ['60-69', '70-79'], sex: null,
    name: 'Douleur — Prothèse de hanche (14 j)',
    phases: [['Aiguë', 3, 240, 8, 6], ['Intermédiaire', 4, 720, 6, 4], ['Consolidation', 7, 1440, 4, 2]] },
  { abbr: 'GEN', op: 'Prothèse de genou', count: 3, precision: 1, ages: ['55-64', '65-74'], sex: null,
    name: 'Douleur — Prothèse de genou (21 j)',
    phases: [['Aiguë', 5, 240, 9, 7], ['Intermédiaire', 7, 720, 7, 4], ['Consolidation', 9, 1440, 4, 2]] },
  { abbr: 'APP', op: 'Appendicectomie', count: 3, precision: 0, ages: ['18-29', '30-39'], sex: null,
    name: 'Douleur — Appendicectomie (10 j)',
    phases: [['Aiguë', 3, 360, 7, 4], ['Récupération', 7, 1440, 4, 2]] },
  { abbr: 'CES', op: 'Césarienne', count: 3, precision: 1, ages: ['25-34', '30-39'], sex: 'F',
    name: 'Douleur — Césarienne (14 j)',
    phases: [['Aiguë', 4, 360, 7, 5], ['Intermédiaire', 5, 720, 5, 3], ['Consolidation', 5, 1440, 3, 1]] },
  { abbr: 'RAC', op: 'Chirurgie du rachis', count: 3, precision: 1, ages: ['40-49', '50-59'], sex: null,
    name: 'Douleur — Chirurgie du rachis (30 j)',
    phases: [['Aiguë', 7, 240, 9, 7], ['Intermédiaire', 8, 720, 7, 5], ['Consolidation', 15, 1440, 5, 2]] },
  { abbr: 'CHO', op: 'Cholécystectomie', count: 2, precision: 0, ages: ['40-49', '50-59'], sex: null,
    name: 'Douleur — Cholécystectomie (7 j)',
    phases: [['Aiguë', 3, 480, 6, 3], ['Récupération', 4, 1440, 3, 1]] },
  { abbr: 'EPA', op: 'Réparation coiffe des rotateurs', count: 2, precision: 2, ages: ['50-59', '60-69'], sex: null,
    name: 'Douleur — Réparation coiffe épaule (21 j)',
    phases: [['Aiguë', 7, 360, 8, 6], ['Intermédiaire', 7, 720, 6, 4], ['Consolidation', 7, 1440, 4, 2]] },
];
const SLEEP = [
  { name: 'Sommeil — suivi 14 jours', precision: 0, phases: [['Suivi', 14, 1440]] },
  { name: 'Sommeil — suivi 21 jours', precision: 0, phases: [['Suivi', 21, 1440]] },
];

function ensureScenario(def, metric) {
  const found = store.listScenarios().find((s) => s.name === def.name);
  if (found) return found;
  return store.createScenario({
    name: def.name, metric, precision: def.precision, description: 'Jeu de démonstration.',
    phases: def.phases.map((p) => ({
      label: p[0], days: p[1], frequencyMinutes: p[2],
      gabaritStart: p[3] != null ? p[3] : null, gabaritEnd: p[4] != null ? p[4] : null,
    })),
  });
}
const durationDays = (s) => (s.phases || []).reduce((a, p) => a + (p.days || 0), 0);

function slotTimes(startMs, scn, until) {
  let cursor = startMs + (scn.startOffsetMinutes || 0) * 60000;
  const out = [];
  (scn.phases || []).forEach((p) => {
    const end = cursor + (p.days || 0) * DAY;
    const step = (p.frequencyMinutes || 0) * 60000;
    if (step > 0) for (let t = cursor; t < end; t += step) { if (t <= until) out.push(t); }
    cursor = end;
  });
  return out;
}

function genScheduled(itvId, scn, startMs, type) {
  const dur = durationDays(scn) || 14, until = Math.min(now, startMs + dur * DAY), tau = Math.max(2, dur / 3);
  const peak = 6 + rnd() * 3;
  const valueAt = (day) => type === 'sleep'
    ? round(clip(4 + 4 * (1 - Math.exp(-day / tau)) + (rnd() - 0.5) * 1.8), 0)
    : round(clip(peak * Math.exp(-day / tau) + 0.6 + (rnd() - 0.5) * 1.6), scn.precision);
  const slots = slotTimes(startMs, scn, until);
  slots.forEach((t, i) => {
    if (rnd() < 0.18) return; // créneau manqué
    store.addMeasurement(itvId, { type, value: valueAt((t - startMs) / DAY), recordedAt: new Date(t).toISOString(), clientId: `${itvId}-${type}-${i}` });
  });
  // 1 saisie spontanée (entre deux créneaux) -> hors planning
  if (slots.length > 5) {
    const k = 3 + Math.floor(rnd() * 3);
    if (slots[k + 1]) {
      const t = (slots[k] + slots[k + 1]) / 2;
      store.addMeasurement(itvId, { type, value: valueAt((t - startMs) / DAY), recordedAt: new Date(t).toISOString(), clientId: `${itvId}-${type}-spont` });
    }
  }
}

function seedDemo() {
  PAIN.forEach((d) => { d.scn = ensureScenario(d, 'pain'); });
  const sleepScns = SLEEP.map((d) => ensureScenario(d, 'sleep'));
  console.log(`${PAIN.length + sleepScns.length} scénarios prêts.`);

  // 20 specs d'intervention.
  const specs = [];
  PAIN.forEach((d) => { for (let k = 1; k <= d.count; k++) specs.push({ d, k }); });

  // 3 interventions réutilisent un patient existant (=> patient déjà suivi).
  const reuse = { 17: 0, 18: 1, 19: 5 };
  const patientByIdx = [];
  let nbReused = 0;

  specs.forEach((spec, idx) => {
    let patient;
    if (idx in reuse) { patient = patientByIdx[reuse[idx]]; nbReused += 1; }
    else patient = store.createPatient({ sex: spec.d.sex || pick(['F', 'M']), ageRange: pick(spec.d.ages) });
    patientByIdx[idx] = patient;

    const startMs = now - rint(idx in reuse ? 2 : 5, 25) * DAY;
    const withSleep = (idx % 2 === 0);
    const sleepScn = withSleep ? pick(sleepScns) : null;
    const itv = store.createIntervention({
      patientId: patient.id,
      pseudo: `${spec.d.abbr}-${spec.k}`,
      operation: spec.d.op,
      startDate: new Date(startMs).toISOString(),
      scenarioIds: sleepScn ? [spec.d.scn.id, sleepScn.id] : [spec.d.scn.id],
    });
    if (withSleep) { genScheduled(itv.id, spec.d.scn, startMs, 'pain'); genScheduled(itv.id, sleepScn, startMs, 'sleep'); }
    else { genScheduled(itv.id, spec.d.scn, startMs, 'pain'); }
  });

  console.log(`${store.listPatients().length} patients, ${specs.length} interventions (dont ${nbReused} déjà suivis), ${store._internal.load().measurements.length} mesures.`);
  console.log('Pseudos interventions : HAN-1..4, GEN-1..3, APP-1..3, CES-1..3, RAC-1..3, CHO-1..2, EPA-1..2.');
  console.log('\nJeu de test prêt. Ouvrez le tableau de bord médecin.');
}

if (require.main === module) {
  (async () => { await store.init(); seedDemo(); await store.flush(); })().catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { seedDemo };
