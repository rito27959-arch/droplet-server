// ============================================================================
// LES JETONS SIGNÉS — attestations Droplet ID (entrantes) et reçus (sortants).
// ----------------------------------------------------------------------------
// Même forme pour les deux : PRÉFIXE.base64url(json).base64url(signature),
// la signature Ed25519 portant sur « PRÉFIXE\n » + le json encodé.
//
//   • L'ATTESTATION (préfixe DIA1) est signée par Droplet ID. Elle dit :
//     « l'appareil X, de clé K, appartient au compte S, pour Droplet Pay ».
//     C'est ce qui attache le solde à la PERSONNE et pas au téléphone : un
//     nouveau téléphone sur le même compte Droplet ID retrouve ses Gouttes.
//
//   • LE REÇU (préfixe DPR1) est signé par Droplet Pay. Il dit « le compte S
//     a droit au produit P jusqu'à telle date ». L'app le vérifie hors ligne
//     avec la clé publique embarquée, comme les licences d'aujourd'hui.
// ============================================================================

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import { ErreurMetier } from './registre.js';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

export function clePriveeDepuisGraine(graine64) {
  const graine = Buffer.from(String(graine64 || ''), 'base64url');
  if (graine.length !== 32) throw new Error('graine Ed25519 invalide (32 octets attendus)');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, graine]), format: 'der', type: 'pkcs8' });
}

export function clePubliqueBrute(clePrivee) {
  return Buffer.from(createPublicKey(clePrivee).export({ format: 'jwk' }).x, 'base64url').toString('base64url');
}

function clePubliqueDepuisBrute(brute64) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: String(brute64) }, format: 'jwk' });
}

export function signerJeton(prefixe, charge, clePrivee) {
  const corps = Buffer.from(JSON.stringify(charge)).toString('base64url');
  const sig = sign(null, Buffer.from(`${prefixe}\n${corps}`), clePrivee).toString('base64url');
  return `${prefixe}.${corps}.${sig}`;
}

export function lireJeton(prefixe, jeton, clePubliqueBrute64) {
  const parts = String(jeton || '').split('.');
  if (parts.length !== 3 || parts[0] !== prefixe) return null;
  let ok = false;
  try {
    ok = verify(null, Buffer.from(`${prefixe}\n${parts[1]}`), clePubliqueDepuisBrute(clePubliqueBrute64), Buffer.from(parts[2], 'base64url'));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Vérifie une attestation Droplet ID et rend `{ compte, appareil, cle }`.
 * `cleRequete` est la clé publique qui a signé la requête : elle doit être
 * celle que l'attestation nomme, sinon on pourrait présenter l'attestation
 * d'un autre.
 */
export function verifierAttestation(jeton, { clePublique, emetteur }, cleRequete) {
  if (!clePublique) throw new ErreurMetier('droplet_id_non_configure', 503);
  const a = lireJeton('DIA1', jeton, clePublique);
  if (!a) throw new ErreurMetier('attestation_invalide', 401);
  const maintenant = Math.floor(Date.now() / 1000);
  if (a.iss !== emetteur || a.aud !== 'droplet-pay') throw new ErreurMetier('attestation_invalide', 401);
  if (!Number.isInteger(a.exp) || a.exp < maintenant) throw new ErreurMetier('attestation_perimee', 401);
  if (typeof a.sub !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(a.sub)) throw new ErreurMetier('attestation_invalide', 401);
  if (typeof a.appareil !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(a.appareil)) throw new ErreurMetier('attestation_invalide', 401);
  if (a.cle !== cleRequete) throw new ErreurMetier('attestation_autre_appareil', 401);
  return { compte: a.sub, appareil: a.appareil, cle: a.cle };
}
