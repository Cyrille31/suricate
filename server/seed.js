'use strict';

/**
 * Initialise des données de démonstration : un scénario type « prothèse de
 * hanche » avec un gabarit de douleur, et un patient de démonstration.
 * Lancer avec : npm run seed
 */

const store = require('./store');

function run() {
  const existing = store.listScenarios();
  let scenario = existing.find((s) => s.name === 'Prothèse de hanche — suivi 14 jours');

  if (!scenario) {
    scenario = store.createScenario({
      name: 'Prothèse de hanche — suivi 14 jours',
      description:
        'Suivi de la douleur post-opératoire après pose de prothèse de hanche. '
        + 'Fréquence élevée les premiers jours, puis dégressive.',
      phases: [
        { label: 'Phase aiguë', days: 3, frequencyMinutes: 240 },   // toutes les 4 h
        { label: 'Phase intermédiaire', days: 4, frequencyMinutes: 720 }, // 2x/jour
        { label: 'Phase de consolidation', days: 7, frequencyMinutes: 1440 }, // 1x/jour
      ],
      // Gabarit : enveloppe de douleur jugée « normale ». Au-delà, alerte.
      gabarit: { min: 0, max: 6 },
      questions: [], // enrichi en MVP-1 (booléen, photo cicatrice, sommeil, ...)
    });
    console.log(`Scénario créé : ${scenario.name} (${scenario.id})`);
  } else {
    console.log(`Scénario déjà présent : ${scenario.name} (${scenario.id})`);
  }

  let patient = store.getPatientByPseudo('demo-hirondelle');
  if (!patient) {
    patient = store.createPatient({
      pseudo: 'demo-hirondelle',
      scenarioId: scenario.id,
      operation: 'Prothèse totale de hanche',
      ageRange: '60-69',
      sex: 'F',
    });
    console.log(`Patient de démo créé : ${patient.pseudo} (${patient.id})`);

    // Quelques mesures, dont une au-dessus du gabarit pour montrer l'alerte.
    const base = Date.now() - 1000 * 60 * 60 * 24 * 3; // il y a 3 jours
    const sample = [2, 3, 4, 5, 8, 4, 3, 2]; // le 8 déclenche une alerte
    sample.forEach((v, i) => {
      store.addMeasurement(patient.id, {
        value: v,
        recordedAt: new Date(base + i * 1000 * 60 * 60 * 8).toISOString(),
        clientId: `seed-${i}`,
      });
    });
    console.log(`${sample.length} mesures de démonstration ajoutées.`);
  } else {
    console.log(`Patient de démo déjà présent : ${patient.pseudo}`);
  }

  console.log('\nDonnées de démonstration prêtes.');
}

run();
