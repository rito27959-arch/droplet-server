#!/usr/bin/env node
// ============================================================================
// Crée l'utilisateur d'API et la clé d'API du BAC À SABLE MTN MoMo.
// ----------------------------------------------------------------------------
// Ce que MTN demande à un humain, et que ce script ne peut pas faire :
//   1. créer un compte sur https://momodeveloper.mtn.com ;
//   2. s'abonner au produit « Collections » ;
//   3. copier la clé d'abonnement (Primary key) depuis son profil.
//
// Ensuite, ce script fait le reste, d'après la documentation officielle
// « API User and Key Management » :
//   POST {base}/apiuser                 X-Reference-Id: <uuid>  { providerCallbackHost }
//   POST {base}/apiuser/{uuid}/apikey   → { apiKey }
//
// Utilisation (la clé ne passe pas par la ligne de commande, ni par l'historique) :
//   MTN_CLE_ABONNEMENT_COLLECTION=… node outils/mtn-sandbox.js pay.exemple.com
//
// Le résultat s'écrit dans mtn-sandbox.env (droits 600), à recopier dans les
// variables Railway, puis à SUPPRIMER. La clé d'API ne peut pas être relue
// chez MTN : perdue, elle se régénère.
// En production, MTN fournit ces identifiants par son portail : ce script
// ne sert qu'au bac à sable.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const base = process.env.MTN_PROVISIONING_BASE || 'https://sandbox.momodeveloper.mtn.com/v1_0';
const abonnement = process.env.MTN_CLE_ABONNEMENT_COLLECTION;
const hote = process.argv[2];

if (!abonnement || !hote) {
  console.error('Usage : MTN_CLE_ABONNEMENT_COLLECTION=… node outils/mtn-sandbox.js <hôte des rappels, ex. pay.exemple.com>');
  process.exit(2);
}

const id = randomUUID();
const r1 = await fetch(`${base}/apiuser`, {
  method: 'POST',
  headers: { 'X-Reference-Id': id, 'Ocp-Apim-Subscription-Key': abonnement, 'Content-Type': 'application/json' },
  body: JSON.stringify({ providerCallbackHost: hote }),
});
if (r1.status !== 201) {
  console.error(`Création de l'utilisateur d'API refusée : HTTP ${r1.status} ${await r1.text()}`);
  process.exit(1);
}

const r2 = await fetch(`${base}/apiuser/${id}/apikey`, {
  method: 'POST',
  headers: { 'Ocp-Apim-Subscription-Key': abonnement },
});
if (r2.status !== 201) {
  console.error(`Création de la clé d'API refusée : HTTP ${r2.status} ${await r2.text()}`);
  process.exit(1);
}
const { apiKey } = await r2.json();

writeFileSync('mtn-sandbox.env', `MTN_ENVIRONNEMENT=sandbox\nMTN_API_USER=${id}\nMTN_API_KEY=${apiKey}\n`, { mode: 0o600 });
console.log(`Utilisateur d'API créé : ${id}`);
console.log('Identifiants écrits dans mtn-sandbox.env (à recopier dans Railway, puis à supprimer).');
