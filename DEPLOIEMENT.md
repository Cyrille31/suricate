# Déploiement — version de test (validation des concepts)

Objectif : une version **en ligne**, que les testeurs ouvrent dans leur navigateur
(smartphone pour le patient, PC pour le médecin), **sans rien installer**, avec la
base de données **hébergée sur le net**.

> ⚠️ Cette version de test **n'assure pas** la confidentialité finale (pas d'HDS,
> base cloud publique). À ne pas utiliser avec de vraies données de santé nominatives.

Tout tient dans **un seul service** : le serveur Node sert l'app patient, l'app
médecin **et** l'API au même endroit (donc aucun souci de CORS).

---

## 1. Créer la base de données en ligne (gratuit) — Upstash Redis

1. Aller sur https://upstash.com → créer un compte (gratuit, sans carte).
2. **Create Database** → un nom (ex. `suricate`), région proche (Europe), type *Regional*.
3. Dans la page de la base, section **REST API**, copier :
   - **UPSTASH_REDIS_REST_URL** (ressemble à `https://xxxx.upstash.io`)
   - **UPSTASH_REDIS_REST_TOKEN** (longue chaîne)

> La base entière de Suricate tient dans une seule clé : pas de schéma à créer.

---

## 2. Déployer le serveur (gratuit) — Render

Votre dépôt GitHub `suricate` contient déjà tout (et un fichier `render.yaml`).

1. Aller sur https://render.com → créer un compte, **se connecter avec GitHub**.
2. **New → Blueprint** → choisir le dépôt `Cyrille31/suricate`.
   Render détecte `render.yaml` et propose le service `suricate`.
3. Renseigner les **variables d'environnement** (onglet *Environment*) :
   - `KV_REST_API_URL` = l'URL Upstash de l'étape 1
   - `KV_REST_API_TOKEN` = le token Upstash
   - `ADMIN_TOKEN` = un mot de passe que **vous** choisissez (pour charger la démo)
4. **Apply / Create** → Render installe et démarre. Au bout d'une minute, vous
   obtenez une URL publique, par ex. `https://suricate.onrender.com`.

> Offre gratuite : le service se met en veille après ~15 min d'inactivité ; la
> première visite suivante prend ~30 s à réveiller. Les données, elles, restent
> dans Upstash (jamais perdues).

---

## 3. Charger les données de démonstration (sans rien installer)

1. Ouvrir `https://VOTRE-URL/admin.html`
2. Saisir le `ADMIN_TOKEN` choisi à l'étape 2.
3. Cliquer **Charger les données de démo** (ou **Vider la base**).

C'est tout : 17 patients / 20 interventions sont créés dans la base en ligne.

---

## 4. Donner les accès aux testeurs

- **Patient (smartphone)** : `https://VOTRE-URL/patient/`
  Sur le téléphone, le navigateur propose « Ajouter à l'écran d'accueil » →
  l'app s'installe comme une vraie application (icône, plein écran, hors-ligne).
  Pseudo de connexion : un pseudo d'intervention, ex. `HAN-1`.
- **Médecin (PC)** : `https://VOTRE-URL/doctor/`
  Rien à installer, un simple navigateur.

> Astuce : générez un QR code de l'URL patient (n'importe quel générateur en ligne)
> et imprimez-le pour les testeurs.

---

## Variante : tout en Docker

Un `Dockerfile` est fourni pour les hébergeurs qui préfèrent Docker
(Fly.io, Railway, etc.). Mêmes variables d'environnement qu'à l'étape 2.

---

## Rappels utiles

- Sans variables `KV_REST_API_*`, le serveur retombe sur le **fichier local**
  `server/data/db.json` (votre mode de développement habituel, inchangé).
- Le numéro de version s'affiche en haut à droite des deux apps : il sert de
  témoin de fraîcheur après une mise à jour.
- Mettre à jour la version en ligne = pousser sur GitHub (`git push`) ; Render
  redéploie automatiquement.
