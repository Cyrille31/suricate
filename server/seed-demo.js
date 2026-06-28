'use strict';

/**
 * Jeu de test conséquent :
 *  - 10 scénarios (douleur variés + sommeil),
 *  - 20 patients (chacun 1 scénario douleur, ~la moitié aussi un sommeil),
 *  - 15 mesures par patient, douleur forte les premiers jours puis décroissante.
 * Lancer :  npm run reset && npm run seed:demo
 *
 * Aléa déterministe (LCG) -> jeu reproductible.
 */

const store = require('./store');

let _seed = 987654321;
function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }
function rint(a, b) { return Math.floor(a + rnd() * (b - a + 1)); }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

function round(v, prec) { const f = Math.pow(10, prec); return Math.round(v * f) / f; }
function clip(v) { return Math.max(0, Math.min(10, v)); }

// --- 10 scénarios ---------------------------------------------------------

const PAIN_SCENARIOS = [
  { name: 'Douleur — Prothèse de hanche (14 j)', precision: 1,
    phases: [['Aiguë', 3, 240, 8, 6], ['Intermédiaire', 4, 720, 6, 4], ['Consolidation', 7, 1440, 4, 2]] },
  { name: 'Douleur — Prothèse de genou (21 j)', precision: 1,
    phases: [['Aiguë', 5, 240, 9, 7], ['Intermédiaire', 7, 720, 7, 4], ['Consolidation', 9, 1440, 4, 2]] },
  { name: 'Douleur — Appendicectomie (10 j)', precision: 0,
    phases: [['Aiguë', 3, 360, 7, 4], ['Récupération', 7, 1440, 4, 2]] },
  { name: 'Douleur — Césarienne (14 j)', precision: 1,
    phases: [['Aiguë', 4, 360, 7, 5], ['Intermédiaire', 5, 720, 5, 3], ['Consolidation', 5, 1440, 3, 1]] },
  { name: 'Douleur — Chirurgie du rachis (30 j)', precision: 1,
    phases: [['Aiguë', 7, 240, 9, 7], ['Intermédiaire', 8, 720, 7, 5], ['Consolidation', 15, 1440, 5, 2]] },
  { name: 'Douleur — Cholécystectomie (7 j)', precision: 0,
    phases: [['Aiguë', 3, 480, 6, 3], ['Récupération', 4, 1440, 3, 1]] },
  { name: 'Douleur — Épaule / coiffe (21 j)', precision: 2,
    phases: [['Aiguë', 7, 360, 8, 6], ['Intermédiaire', 7, 720, 6, 4], ['Consolidation', 7, 1440, 4, 2]] },
];

const SLEEP_SCENARIOS = [
  { name: 'Sommeil — suivi 14 jours', precision: 0, phases: [['Suivi', 14, 1440]] },
  { name: 'Sommeil — suivi 21 jours', precision: 0, phases: [['Suivi', 21, 1440]] },
  { name: 'Sommeil — suivi hebdomadaire (28 j)', precision: 0, phases: [['Suivi', 28, 10080]] },
];

function makeScenario(def, metric) {
  const existing = store.listScenarios().find((s) => s.name === def.name);
  if (existing) return existing;
  return store.createScenario({
    name: def.name, metric, precision: def.precision,
    description: 'Jeu de démonstration.',
    phases: def.phases.map((p) => ({
      label: p[0], days: p[1], frequencyMinutes: p[2],
      gabaritStart: p[3] != null ? p[3] : null,
      gabaritEnd: p[4] != null ? p[4] : null,
    })),
  });
}

// --- Génération -----------------------------------------------------------

const OPERATIONS = ['Prothèse de hanche', 'Prothèse de genou', 'Appendicectomie', 'Césarienne',
  'Chirurgie du rachis', 'Cholécystectomie', 'Réparation coiffe', 'Hernie inguinale'];
const AGES = ['18-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80+'];
const SEX = ['F', 'M'];

function scenarioDurationDays(s) { return (s.phases || []).reduce((a, p) => a + (p.days || 0), 0); }

function genPain(patientId, painScn, startMs, n) {
  const durDays = scenarioDurationDays(painScn) || 14;
  const elapsedMs = Math.min(now - startMs, durDays * DAY);
  const peak = 6 + rnd() * 3;            // douleur initiale 6–9
  const tau = Math.max(2, durDays / 3);  // décroissance
  for (let i = 0; i < n; i++) {
    const frac = n > 1 ? i / (n - 1) : 0;
    const tMs = startMs + frac * elapsedMs;
    const day = (tMs - startMs) / DAY;
    const noise = (rnd() - 0.5) * 1.6;
    const value = clip(peak * Math.exp(-day / tau) + 0.6 + noise); // +léger plateau
    store.addMeasurement(patientId, {
      type: 'pain', value: round(value, painScn.precision),
      recordedAt: new Date(tMs).toISOString(), clientId: `${patientId}-pain-${i}`,
    });
  }
}

function genSleep(patientId, sleepScn, startMs, n) {
  const durDays = scenarioDurationDays(sleepScn) || 14;
  const elapsedMs = Math.min(now - startMs, durDays * DAY);
  const tau = Math.max(2, durDays / 3);
  for (let i = 0; i < n; i++) {
    const frac = n > 1 ? i / (n - 1) : 0;
    const tMs = startMs + frac * elapsedMs;
    const day = (tMs - startMs) / DAY;
    const noise = (rnd() - 0.5) * 1.8;
    const value = clip(4 + 4 * (1 - Math.exp(-day / tau)) + noise); // s'améliore avec le temps
    store.addMeasurement(patientId, {
      type: 'sleep', value: round(value, sleepScn.precision),
      recordedAt: new Date(tMs).toISOString(), clientId: `${patientId}-sleep-${i}`,
    });
  }
}

function run() {
  const painScns = PAIN_SCENARIOS.map((d) => makeScenario(d, 'pain'));
  const sleepScns = SLEEP_SCENARIOS.map((d) => makeScenario(d, 'sleep'));
  console.log(`${painScns.length + sleepScns.length} scénarios prêts (${painScns.length} douleur, ${sleepScns.length} sommeil).`);

  let created = 0;
  for (let i = 1; i <= 20; i++) {
    const pseudo = `patient-${String(i).padStart(3, '0')}`;
    if (store.getPatientByPseudo(pseudo)) continue;

    const painScn = painScns[i % painScns.length];
    const withSleep = (i % 2 === 0);
    const sleepScn = withSleep ? sleepScns[i % sleepScns.length] : null;
    const scenarioIds = sleepScn ? [painScn.id, sleepScn.id] : [painScn.id];

    const startMs = now - rint(3, 25) * DAY; // suivi commencé il y a 3 à 25 jours
    const patient = store.createPatient({
      pseudo, scenarioIds, startDate: new Date(startMs).toISOString(),
      operation: pick(OPERATIONS), ageRange: pick(AGES), sex: pick(SEX),
    });

    if (withSleep) { genPain(patient.id, painScn, startMs, 10); genSleep(patient.id, sleepScn, startMs, 5); }
    else { genPain(patient.id, painScn, startMs, 15); }
    created += 1;
  }
  console.log(`${created} patients créés, 15 mesures chacun.`);
  console.log('\nJeu de test prêt. Ouvrez le tableau de bord médecin.');
}

run();
