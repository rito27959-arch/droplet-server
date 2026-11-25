#!/usr/bin/env node
// Génère une paire Ed25519 et l'écrit dans un fichier (droits 600).
//   node outils/cles.js recus        → PAY_CLE_RECUS pour Droplet Pay
//   node outils/cles.js attestation  → ATTESTATION_GRAINE pour Droplet ID
// La clé PUBLIQUE s'affiche : c'est elle qu'on met dans l'app (reçus) ou dans
// DROPLET_ID_CLE_ATTESTATION (attestations). La graine ne s'affiche jamais.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const usage = { recus: 'PAY_CLE_RECUS', attestation: 'ATTESTATION_GRAINE' }[process.argv[2]];
if (!usage) {
  console.error('Usage : node outils/cles.js recus|attestation');
  process.exit(2);
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const graine = privateKey.export({ format: 'jwk' }).d;
const pub = publicKey.export({ format: 'jwk' }).x;
const fichier = `${process.argv[2]}.cle`;
writeFileSync(fichier, `${usage}=${graine}\n`, { mode: 0o600 });
console.log(`Graine écrite dans ${fichier} (à recopier dans Railway, puis à supprimer).`);
console.log(`Clé publique : ${pub}`);
