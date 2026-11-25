// Outils de test. La base est un VRAI PostgreSQL (TEST_DATABASE_URL) ; seuls
// les opérateurs sont remplacés par des doubles de test, clairement nommés.

import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

import { chargerConfig } from '../src/config.js';
import { migrer, ouvrir } from '../src/db.js';
import { clePriveeDepuisGraine, clePubliqueBrute, signerJeton } from '../src/jetons.js';
import { texteASigner } from '../src/signature.js';
import { creerApp } from '../src/app.js';

export const URL_TEST = process.env.TEST_DATABASE_URL || 'postgres://pay@localhost:54329/pay_test?host=/tmp';

export async function baseNeuve() {
  const pool = ouvrir(URL_TEST);
  await pool.query('drop schema if exists public cascade; create schema public;');
  await migrer(pool);
  return pool;
}

export function graine() {
  return randomBytes(32).toString('base64url');
}

/** Un double de fournisseur : on décide à la main ce que « l'opérateur » répond. */
export function fournisseurDouble(nom = 'double', devise = 'XAF') {
  const etats = new Map();
  const f = {
    nom,
    disponible: true,
    devise,
    appels: [],
    reponseInitier: null, // une Error à lancer, sinon succès
    async initier(a) {
      f.appels.push(['initier', a]);
      if (f.reponseInitier) throw f.reponseInitier;
      etats.set(`ref-${a.reference}`, { etat: 'en_attente', montant: a.montant, devise });
      return { refFournisseur: `ref-${a.reference}` };
    },
    async statut(ref) {
      f.appels.push(['statut', ref]);
      return etats.get(ref) ?? { etat: 'inconnu' };
    },
    regler(reference, s) {
      etats.set(`ref-${reference}`, { devise, ...etats.get(`ref-${reference}`), ...s });
    },
  };
  return f;
}

export function fournisseursDe(f) {
  return { tous: { [f.nom]: f }, pour: (op) => (op === 'mtn' || op === 'orange' ? f : null), par: (n) => (n === f.nom ? f : null) };
}

export async function demarrer({ pool, fournisseur }) {
  const cleDroplet = clePriveeDepuisGraine(graine());
  const cleRecus = clePriveeDepuisGraine(graine());
  const config = chargerConfig({
    dropletId: { emetteur: 'https://id-test.dropletmesh.app', clePublique: clePubliqueBrute(cleDroplet) },
  });
  const serveur = creerApp({ pool, config, fournisseurs: fournisseursDe(fournisseur), clePriveeRecus: cleRecus });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  return { serveur, base, config, cleDroplet, cleRecusPub: clePubliqueBrute(cleRecus) };
}

/** Un appareil : sa clé Ed25519 et de quoi signer ses requêtes. */
export function appareil(env, { compte = `compte_${randomBytes(6).toString('hex')}`, id = `app_${randomBytes(6).toString('hex')}` } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const cle = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64url');

  async function requete(methode, chemin, corps, { enregistrement = false, entetes = {}, falsifier = null } = {}) {
    const texte = corps === undefined ? '' : JSON.stringify(corps);
    const ts = Math.floor(Date.now() / 1000) + (falsifier?.decalage ?? 0);
    const nonce = falsifier?.nonce ?? randomBytes(16).toString('base64url');
    let sig = sign(null, Buffer.from(texteASigner(methode, chemin, ts, nonce, texte)), privateKey).toString('base64url');
    if (falsifier?.sig) sig = `${sig.slice(0, -4)}AAAA`;
    const h = {
      'Content-Type': 'application/json',
      'X-Droplet-Ts': String(ts),
      'X-Droplet-Nonce': nonce,
      'X-Droplet-Sig': sig,
      ...(enregistrement ? { 'X-Droplet-Cle': cle } : { 'X-Droplet-Appareil': id }),
      ...entetes,
    };
    const rep = await fetch(env.base + chemin, { method: methode, headers: h, body: methode === 'GET' ? undefined : texte });
    return { statut: rep.status, corps: await rep.json() };
  }

  function attestation(surcharges = {}) {
    return signerJeton('DIA1', {
      iss: 'https://id-test.dropletmesh.app',
      aud: 'droplet-pay',
      sub: compte,
      appareil: id,
      cle,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...surcharges,
    }, env.cleDroplet);
  }

  return {
    compte,
    id,
    cle,
    requete,
    attestation,
    enregistrer: (a = attestation()) => requete('POST', '/v1/appareils', { attestation: a }, { enregistrement: true }),
  };
}
