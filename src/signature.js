// ============================================================================
// LES REQUÊTES SIGNÉES — le même protocole que Droplet ID.
// ----------------------------------------------------------------------------
// L'app signe chaque requête avec la clé Ed25519 de son appareil Droplet ID :
//
//   X-Droplet-Appareil  identifiant de l'appareil (ou, à l'enregistrement,
//   X-Droplet-Cle       sa clé publique brute en base64url)
//   X-Droplet-Ts        heure, secondes Unix
//   X-Droplet-Nonce     aléatoire, neuf à chaque requête
//   X-Droplet-Sig       base64url(Ed25519(MÉTHODE\nchemin\nheure\nnonce\nsha256-hex(corps)))
//
// Aucune requête qui touche à l'argent n'est acceptée sans cette signature.
// Elle remplace un mot de passe : il n'y en a pas, et l'app ne demande jamais
// le code secret MoMo ou Orange.
// ============================================================================

import { createHash, createPublicKey, verify } from 'node:crypto';

import { ErreurMetier } from './registre.js';

export function texteASigner(methode, chemin, ts, nonce, corps) {
  const h = createHash('sha256').update(corps ?? '').digest('hex');
  return `${methode.toUpperCase()}\n${chemin}\n${ts}\n${nonce}\n${h}`;
}

export function clePublique(brute64) {
  const brute = Buffer.from(String(brute64 || ''), 'base64url');
  if (brute.length !== 32) throw new ErreurMetier('cle_invalide', 401);
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: brute.toString('base64url') }, format: 'jwk' });
}

/**
 * Vérifie la signature. Rend `{ appareil, compte }` pour un appareil connu,
 * ou `{ cleBrute }` quand la requête se présente avec sa clé (enregistrement).
 */
export async function verifierRequete(c, { methode, chemin, entetes, corps, fenetre }) {
  const ts = Number(entetes['x-droplet-ts']);
  const nonce = entetes['x-droplet-nonce'];
  const sig = entetes['x-droplet-sig'];
  const idAppareil = entetes['x-droplet-appareil'];
  const cleBrute = entetes['x-droplet-cle'];

  if (!ts || !nonce || !sig || (!idAppareil && !cleBrute)) throw new ErreurMetier('signature_absente', 401);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new ErreurMetier('nonce_invalide', 401);
  if (Math.abs(Date.now() / 1000 - ts) > fenetre) throw new ErreurMetier('signature_perimee', 401);

  let appareil = null;
  let cle;
  if (idAppareil) {
    const r = await c.query('select id, compte, cle_pub, revoque_le from appareils where id = $1', [idAppareil]);
    appareil = r.rows[0];
    if (!appareil) throw new ErreurMetier('appareil_inconnu', 401);
    if (appareil.revoque_le) throw new ErreurMetier('appareil_revoque', 401);
    cle = clePublique(appareil.cle_pub);
  } else {
    cle = clePublique(cleBrute);
  }

  const ok = verify(null, Buffer.from(texteASigner(methode, chemin, ts, nonce, corps)), cle, Buffer.from(sig, 'base64url'));
  if (!ok) throw new ErreurMetier('signature_invalide', 401);

  // Le nonce n'est consommé qu'une fois la signature vérifiée : un inconnu ne
  // peut pas « brûler » les nonces de quelqu'un d'autre.
  const n = await c.query('insert into nonces (nonce) values ($1) on conflict do nothing', [nonce]);
  if (n.rowCount === 0) throw new ErreurMetier('requete_rejouee', 401);

  return appareil ? { appareil: appareil.id, compte: appareil.compte } : { cleBrute };
}

/** Les nonces plus vieux que la fenêtre ne servent plus à rien. */
export async function purgerNonces(c, fenetre) {
  await c.query(`delete from nonces where vu_le < now() - make_interval(secs => $1)`, [fenetre * 2]);
}
