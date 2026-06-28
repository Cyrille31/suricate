'use strict';

/**
 * Données de démonstration :
 *  - un scénario DOULEUR (jauge 1 décimale, gabarit décroissant),
 *  - un scénario SOMMEIL (jauge entière, informatif),
 *  - un patient démo abonné aux DEUX scénarios.
 * Lancer : npm run seed
 */

const store = require('./store');

function getOrCreateScenario(match, def) {
  const found = store.listScenarios().find(match);
  if (found) { console.log(`Scénario déjà présent : ${found.name}`); return found; }
  const s = store.createScenario(def);
  console.log(`Scénario créé : ${s.name} (${s.metric}, ${s.precision} déc.)`);
  return s;
}

function run() {
  const pain = getOrCreateScenario(
    (s) => s.name === 'Douleur — prothèse de hanche (14 j)',
    {
      name: 'Douleur — prothèse de hanche (14 j)',
      description: 'Suivi de la douleur post-opératoire. Seuil d\'alerte décroissant.',
      metric: 'pain',
      precision: 1,
      phases: [
        { label: 'Phase aiguë', days: 3, frequencyMinutes: 240, gabaritStart: 8, gabaritEnd: 6 },
        { label: 'Phase intermédiaire', days: 4, frequencyMinutes: 720, gabaritStart: 6, gabaritEnd: 4 },
        { label: 'Phase de consolidation', days: 7, frequencyMinutes: 1440, gabaritStart: 4, gabaritEnd: 2 },
      ],
    }
  );

  const sleep = getOrCreateScenario(
    (s) => s.name === 'Sommeil — suivi 14 jours',
    {
      name: 'Sommeil — suivi 14 jours',
      description: 'Qualité du sommeil, une fois par jour (informatif, sans alerte).',
      metric: 'sleep',
      precision: 0,
      phases: [
        { label: 'Suivi quotidien', days: 14, frequencyMinutes: 1440 }, // pas de seuil
      ],
    }
  );

  let patient = store.getPatientByPseudo('demo-hirondelle');
  if (!patient) {
    const base = Date.now() - 1000 * 60 * 60 * 24 * 3; // début : il y a 3 jours
    patient = store.createPatient({
      pseudo: 'demo-hirondelle',
      scenarioIds: [pain.id, sleep.id],
      startDate: new Date(base).toISOString(),
      operation: 'Prothèse totale de hanche',
      ageRange: '60-69',
      sex: 'F',
    });
    console.log(`Patient de démo créé : ${patient.pseudo} (2 scénarios)`);

    const painVals = [2, 3.5, 4, 5.5, 8, 4, 3, 2.5];
    painVals.forEach((v, i) => store.addMeasurement(patient.id, {
      type: 'pain', value: v,
      recordedAt: new Date(base + i * 1000 * 60 * 60 * 8).toISOString(),
      clientId: `seed-pain-${i}`,
    }));

    const sleepVals = [4, 6, 7];
    sleepVals.forEach((v, i) => store.addMeasurement(patient.id, {
      type: 'sleep', value: v,
      recordedAt: new Date(base + i * 1000 * 60 * 60 * 24 + 1000 * 60 * 60 * 8).toISOString(),
      clientId: `seed-sleep-${i}`,
    }));
    console.log(`${painVals.length} mesures de douleur + ${sleepVals.length} de sommeil.`);
  } else {
    console.log(`Patient de démo déjà présent : ${patient.pseudo}`);
  }

  console.log('\nDonnées de démonstration prêtes.');
}

run();
