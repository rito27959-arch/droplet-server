# Droplet Pay — Droplet Credits (DC) et Droplet Store

Des crédits Droplet en **boucle fermée** : on en achète par MTN MoMo ou Orange Money (1 DC = 1 F dans chaque pack), on les dépense dans le Droplet Store, on ne les retire pas, on ne les transfère pas. On peut offrir un **article**, jamais des DC.

- **Registre en partie double** dans PostgreSQL. Les montants sont des entiers, il n'y a pas de découvert, les écritures sont en ajout seul et le journal d'audit est chaîné (`src/schema.sql`, `src/registre.js`).
- **Recharges** : crédit seulement sur confirmation relue chez l'opérateur, une seule fois, et réconciliation toutes les 30 s (`src/recharges.js`).
- **Store** : catalogue en base, réglable sans redéployer (produits, catégories, collections, packs, historique des prix pour mesurer la demande) ; articles gratuits ; collections qui ne refacturent pas ce qu'on possède ; abonnements sans renouvellement automatique ; reçus signés, vérifiables hors ligne (`src/catalogue.js`, `src/achats.js`).
- **Administration** : `/admin` (page) et `/admin/v1/*` (API) derrière un jeton dont seule l'empreinte est en variable (`ADMIN_JETON_SHA256`). Prix, statuts, packs, recharges et leurs événements, transactions, remboursements, modération, créateurs, abonnements, signaux suspects, intégrité du registre et du journal. L'administration ne peut pas créditer un portefeuille (`src/admin.js`, `src/admin.html`).
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
| `ADMIN_JETON_SHA256` | Empreinte du jeton d'administration (`printf '%s' "$JETON" \| sha256sum`). Sans elle, `/admin` répond 404. |

Par défaut, tout est en bac à sable : il faut écrire `production` pour encaisser de l'argent réel.

## Tester

Les tests tournent sur un **vrai PostgreSQL** (`TEST_DATABASE_URL`). Seuls les opérateurs sont remplacés par des doubles de test.

```sh
TEST_DATABASE_URL=postgres://… npm test
```

## Correspondance avec la spécification

| Spécification | Ici |
| --- | --- |
| users | `comptes` (identifiant propre à Pay, attesté par Droplet ID) |
| credit_accounts | `comptes_registre` |
| credit_transactions | `operations` + `ecritures` (partie double) |
| credit_packages | `paliers` |
| payment_orders / payment_events | `recharges` / `evenements_paiement` |
| store_products / creator_products | `produits` (champ `createur`, statut de modération) |
| product_categories | `categories`, et `collections` |
| user_inventory / subscriptions | `droits` (sans fin = possédé ; daté = abonnement) |
| creator_profiles | `createurs` |
| admin_audit_logs | `journal` (chaîné, en ajout seul) |
