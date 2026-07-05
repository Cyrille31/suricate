# Suricate

> **Version de test en ligne (validation des concepts)** : voir [`DEPLOIEMENT.md`](DEPLOIEMENT.md) — hébergement gratuit (Render + base Upstash), apps accessibles par URL sans installation.

Suivi de la douleur post-opératoire à domicile.
**Maître d'œuvre : CGExcel.** État : **MVP‑0** (prototype de démonstration).

Le patient note sa douleur (0–10) depuis son smartphone ; les données sont
centralisées ; le médecin visualise la courbe de chaque patient et reçoit une
alerte si elle sort du *gabarit* attendu pour l'opération concernée.

---

## Démarrage rapide

Prérequis : **Node.js ≥ 18** (testé sur Node 22). Aucune dépendance à installer,
aucune base de données à configurer.

```bash
git clone <votre-dépôt>
cd suricate
npm run seed     # crée un scénario + un patient de démonstration
npm start        # démarre le serveur
```

Puis ouvrez :

- Accueil : <http://localhost:3000/>
- **Application patient** : <http://localhost:3000/patient/> (pseudo de démo : `demo-hirondelle`)
- **Tableau de bord médecin** : <http://localhost:3000/doctor/>

Commandes utiles :

```bash
npm test          # test de fumée de l'API (bout en bout)
npm run reset     # efface la base locale
npm run seed:demo # gros jeu de test : 10 scénarios, 20 patients, 15 mesures chacun
```

---

## Ce que fait le MVP‑0

- **App patient (PWA)** : connexion par pseudo, puis saisie sur **jauge** — on
  déplace le curseur, la valeur s'affiche en grand, un gros bouton **Validation**.
  Le patient enchaîne les métriques qu'il suit (douleur, sommeil…). La **douleur
  accepte des décimales** (0, 1 ou 2 chiffres, réglé par le scénario).
  **Fonctionne hors‑ligne** (file d'attente, envoi idempotent). Bouton **Quitter**.
- **Scénarios typés** : chaque scénario porte une **mesure** (douleur ou
  sommeil), une **précision décimale**, des **phases** (fréquence en j/h/min) et
  un **seuil d'alerte variable** (niveau au début et à la fin de chaque phase,
  interpolé ; optionnel). Le médecin peut **modifier** un scénario et en **créer
  un à partir d'un existant** (copie).
- **Plusieurs scénarios par patient** : on peut affecter, p. ex., un scénario
  douleur **et** un scénario sommeil au même patient.
- **Tableau de bord médecin** : liste des patients, **courbe de douleur** avec
  seuil variable + **courbe de sommeil**, alerte sur dépassement de seuil.
  Graphiques **zoomables à la molette** et **défilables** (axe gradué par jour,
  ou par lundi quand c'est trop serré).
- **Confidentialité** : le serveur ne stocke **jamais** le nom du patient,
  seulement le pseudo. La correspondance pseudo ↔ nom reste dans le navigateur
  du médecin.
- **Identité** : logos Suricate et CGExcel (maître d'œuvre) intégrés.

### Modèle & confidentialité (v0.7)

Deux entités distinctes, et **deux bases séparées** :

- **Patient** = la personne. Peut avoir **plusieurs interventions**. Une étude
  de recherche peut ainsi savoir si un patient a déjà été suivi.
- **Intervention** = un épisode opératoire (opération, date de début, scénarios,
  mesures). C'est le pseudo de l'intervention que le patient saisit dans l'app.

| Donnée                              | Où elle vit                                   |
| ----------------------------------- | --------------------------------------------- |
| Identité réelle (nom, tél., e-mail, adresse) | **Base patient — poste du médecin** (localStorage), jamais envoyée |
| Pseudo patient + pseudo intervention | Base recherche (serveur)                      |
| Sexe, tranche d'âge                 | Base recherche (serveur, patient)             |
| Opération, date de début, scénarios | Base recherche (serveur, intervention)        |
| Mesures (douleur, sommeil)          | Base recherche (serveur, rattachées à l'intervention) |

Le tableau de bord a trois onglets : **Interventions** (suivi + courbes),
**Patients** (personnes et leurs interventions), **Scénarios**. La liste se
filtre par un champ de recherche (nom ou pseudo).

---

## Architecture

```
suricate/
├── server/
│   ├── index.js     # serveur HTTP natif : API REST + fichiers statiques
│   ├── store.js     # accès aux données (fichier JSON) — ISOLÉ, remplaçable par SQLite/PostgreSQL
│   ├── seed.js      # données de démonstration
│   └── data/        # base locale (ignorée par git)
├── public/
│   ├── patient/     # PWA patient (HTML/CSS/JS vanilla + service worker)
│   └── doctor/      # tableau de bord médecin (graphique SVG fait main)
├── test/smoke.js    # test de fumée de l'API
└── .github/workflows/ci.yml
```

Choix MVP‑0 : **zéro dépendance** (serveur Node natif, persistance fichier,
front vanilla, graphique SVG maison) pour un `git clone && npm start` qui
fonctionne partout sans build. Tout l'accès aux données passe par `store.js`,
ce qui rendra la migration vers une vraie base (puis un hébergement HDS) propre.

### API (extrait)

| Méthode | Route                                   | Rôle                          |
| ------- | --------------------------------------- | ----------------------------- |
| GET     | `/api/scenarios`                        | liste des scénarios           |
| POST    | `/api/scenarios`                        | créer un scénario             |
| GET     | `/api/patients`                         | liste des patients (pseudos)  |
| POST    | `/api/patients`                         | créer un patient              |
| GET     | `/api/patients/by-pseudo/:pseudo`       | connexion app patient         |
| POST    | `/api/patients/:id/measurements`        | saisir une mesure (ou un lot) |
| GET     | `/api/patients/:id/series`              | courbe + gabarit + alertes    |

---

## Feuille de route

- **MVP‑0 (actuel)** — boucle complète : saisie douleur, hors‑ligne, courbe, alerte.
- **MVP‑1** — questionnaires riches (booléen, nombre, texte, **photo de
  cicatrice**, qualité de sommeil), fréquences jour/nuit et dégressives,
  mode d'emploi embarqué, demandes/consignes au patient.
- **MVP‑2** — agrégation pour la recherche + exports, authentification médecin,
  notifications fiables (app native React Native/Flutter, push serveur),
  base SQLite/PostgreSQL.
- **Industrialisation** — voir ci‑dessous (non codable seul).

---

## ⚠ Points réglementaires (à traiter en parallèle du développement)

Ce dépôt est un **prototype technique**. Une mise en service réelle suppose un
travail réglementaire qui n'est pas du code et qui structure le projet :

- **Dispositif médical / marquage CE** : la fonction d'**alerte clinique**
  (courbe qui sort d'un gabarit lié à une pathologie) fait très probablement
  basculer le logiciel dans la catégorie *logiciel dispositif médical*
  (règlement UE 2017/745, règle 11 → classe IIa probable). Implique ISO 13485,
  évaluation clinique, dossier technique, organisme notifié.
- **Hébergement de données de santé (HDS)** : obligatoire pour la production.
  À noter : cela entre en tension avec l'exigence « outils gratuits » — les
  briques logicielles sont gratuites, **l'hébergement conforme ne l'est pas**.
- **RGPD** : analyse d'impact (AIPD), base légale, consentement, minimisation.
- **Ségur du numérique en santé** : interopérabilité (INS, Mon espace santé,
  MSSanté, FHIR…).
- **Sécurité clinique** : le mode hors‑ligne peut **retarder** une alerte ;
  l'application **n'est pas un dispositif d'urgence** (l'app patient rappelle
  d'appeler le 15).

Ces points appellent un accompagnement par un spécialiste DM / RGPD santé.

---

## Licence

MIT (proposée à titre indicatif — voir `LICENSE`). Logo Suricate et identité
CGExcel à intégrer lorsqu'ils seront fournis.
