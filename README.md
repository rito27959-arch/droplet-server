# Droplet Pay — les Gouttes

Des crédits Droplet en **boucle fermée**, à la manière des étoiles de Telegram : on en achète par MTN MoMo ou Orange Money, on les dépense dans Droplet, on ne les retire pas.

- **Registre en partie double** dans PostgreSQL. Les montants sont des entiers, il n'y a pas de découvert, les écritures sont en ajout seul et le journal d'audit est chaîné (`src/schema.sql`, `src/registre.js`).
- **Recharges** : crédit seulement sur confirmation relue chez l'opérateur, une seule fois, et réconciliation toutes les 30 s (`src/recharges.js`).
- **Boutique** : Pro, packs, stickers et cadeaux à offrir ; reçus signés, vérifiables hors ligne (`src/catalogue.js`, `src/achats.js`).
- **Opérateurs** : MTN en direct, Fapshi (MTN et Orange), Orange en direct en attente de sa spécification (`src/fournisseurs/`, `docs/API-FOURNISSEURS.md`).
- **Identité** : requêtes signées par la clé d'appareil Droplet ID. Le compte est attesté par Droplet ID (`POST /v1/attestations`, branche `pay-attestation`).

## Lancer

```sh
npm install
DATABASE_URL=postgres://… npm start
```

| Variable | Rôle |
| --- | --- |
| `DATABASE_URL` | Base PostgreSQL dédiée (jamais celle de Droplet ID) |
| `DROPLET_ID_EMETTEUR`, `DROPLET_ID_CLE_ATTESTATION` | Qui atteste les appareils (clé publique Ed25519) |
| `PAY_CLE_RECUS` | Graine qui signe les reçus (`node outils/cles.js recus`) |
| `MTN_CLE_ABONNEMENT_COLLECTION`, `MTN_API_USER`, `MTN_API_KEY` | MTN (bac à sable : `node outils/mtn-sandbox.js`) |
| `MTN_ENVIRONNEMENT`, `MTN_DEVISE` | `sandbox` / `EUR` par défaut |
| `FAPSHI_USER`, `FAPSHI_KEY`, `FAPSHI_BASE` | Fapshi (bac à sable par défaut) |
| `ADRESSE_PUBLIQUE` | Pour les rappels des opérateurs |

Par défaut, tout est en bac à sable : il faut écrire `production` pour encaisser de l'argent réel.

## Tester

Les tests tournent sur un **vrai PostgreSQL** (`TEST_DATABASE_URL`). Seuls les opérateurs sont remplacés par des doubles de test.

```sh
TEST_DATABASE_URL=postgres://… npm test
```
