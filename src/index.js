import { chargerConfig } from './config.js';
import { migrer, ouvrir } from './db.js';
import { creerFournisseurs } from './fournisseurs/index.js';
import { clePriveeDepuisGraine } from './jetons.js';
import { reconcilier } from './recharges.js';
import { verifierRegistre } from './registre.js';
import { purgerNonces } from './signature.js';
import { creerApp } from './app.js';

const config = chargerConfig();
const pool = ouvrir(config.baseDeDonnees);
await migrer(pool);

const fournisseurs = creerFournisseurs(config);
const clePriveeRecus = config.cleRecus ? clePriveeDepuisGraine(config.cleRecus) : null;

for (const f of Object.values(fournisseurs.tous)) {
  console.log(`[pay] ${f.nom} : ${f.disponible ? 'actif' : `inactif (${f.raison})`}`);
}
if (!clePriveeRecus) console.warn('[pay] PAY_CLE_RECUS absente : les droits seront rendus sans reçu signé');
if (!config.dropletId.clePublique) console.warn('[pay] DROPLET_ID_CLE_ATTESTATION absente : aucun appareil ne peut s’enregistrer');

creerApp({ pool, config, fournisseurs, clePriveeRecus }).listen(config.port, () => console.log(`[pay] écoute sur ${config.port}`));

// La réconciliation : toutes les 30 s, relire ce qui attend encore.
setInterval(() => {
  reconcilier(pool, fournisseurs, config).catch((e) => console.error('[pay] réconciliation', e.message));
}, 30_000);

// Une fois par heure : purge des nonces, et contrôle d'intégrité du registre.
setInterval(async () => {
  try {
    await purgerNonces(pool, config.fenetreSignature);
    const anomalies = await verifierRegistre(pool);
    if (anomalies.length) console.error('[pay] ANOMALIES DU REGISTRE', JSON.stringify(anomalies, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch (e) {
    console.error('[pay] contrôle', e.message);
  }
}, 3_600_000);
