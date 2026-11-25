import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { acheter } from '../src/achats.js';
import { enTransaction } from '../src/db.js';
import { lireJeton } from '../src/jetons.js';
import { reconcilier } from '../src/recharges.js';
import { verifierRegistre } from '../src/registre.js';
import { verifierJournal } from '../src/journal.js';
import { appareil, baseNeuve, demarrer, fournisseurDouble, fournisseursDe } from './outils.js';

let pool;
let env;
let op; // le double d'opérateur
before(async () => {
  pool = await baseNeuve();
  op = fournisseurDouble('double');
  env = await demarrer({ pool, fournisseur: op });
});
after(async () => {
  env.serveur.close();
  await pool.end();
});

async function rechargerEtConfirmer(a, palier = 'g100', cle = `r-${Math.random().toString(36).slice(2, 12)}`) {
  const r = await a.requete('POST', '/v1/recharges', { palier, operateur: 'mtn', telephone: '+237 6 99 00 11 22' }, { entetes: { 'Idempotency-Key': cle } });
  assert.equal(r.statut, 200, JSON.stringify(r.corps));
  op.regler(r.corps.id, { etat: 'reussie' });
  const s = await a.requete('GET', `/v1/recharges/${r.corps.id}`);
  assert.equal(s.corps.etat, 'reussie');
  return r.corps.id;
}

describe('enregistrement et signatures', () => {
  test('le catalogue est public, les montants sont des chaînes', async () => {
    const r = await fetch(`${env.base}/v1/catalogue`).then((x) => x.json());
    assert.equal(r.unite, 'goutte');
    assert.ok(r.produits.every((p) => typeof p.prix === 'string'));
    assert.ok(r.paliers.find((p) => p.cle === 'g50' && p.montantXaf === '500'));
  });

  test('une attestation valide enregistre l’appareil', async () => {
    const a = appareil(env);
    const r = await a.enregistrer();
    assert.equal(r.statut, 200);
    assert.equal(r.corps.compte, a.compte);
    const moi = await a.requete('GET', '/v1/moi');
    assert.equal(moi.corps.solde, '0');
  });

  test('l’attestation d’un autre appareil est refusée', async () => {
    const a = appareil(env);
    const b = appareil(env);
    const r = await b.requete('POST', '/v1/appareils', { attestation: a.attestation() }, { enregistrement: true });
    assert.equal(r.statut, 401);
    assert.equal(r.corps.erreur, 'attestation_autre_appareil');
  });

  test('attestation périmée, mauvais public visé, mauvaise signature : refusés', async () => {
    const a = appareil(env);
    assert.equal((await a.enregistrer(a.attestation({ exp: 10 }))).corps.erreur, 'attestation_perimee');
    assert.equal((await a.enregistrer(a.attestation({ aud: 'autre' }))).corps.erreur, 'attestation_invalide');
    const t = a.attestation();
    assert.equal((await a.enregistrer(`${t.slice(0, -4)}AAAA`)).corps.erreur, 'attestation_invalide');
  });

  test('signature fausse, requête rejouée, requête trop vieille : refusées', async () => {
    const a = appareil(env);
    await a.enregistrer();
    assert.equal((await a.requete('GET', '/v1/moi', undefined, { falsifier: { sig: true } })).corps.erreur, 'signature_invalide');
    const nonce = 'abcdefghijklmnopqrstuv';
    assert.equal((await a.requete('GET', '/v1/moi', undefined, { falsifier: { nonce } })).statut, 200);
    assert.equal((await a.requete('GET', '/v1/moi', undefined, { falsifier: { nonce } })).corps.erreur, 'requete_rejouee');
    assert.equal((await a.requete('GET', '/v1/moi', undefined, { falsifier: { decalage: -900 } })).corps.erreur, 'signature_perimee');
  });

  test('un appareil inconnu ne voit rien', async () => {
    const a = appareil(env);
    assert.equal((await a.requete('GET', '/v1/moi')).corps.erreur, 'appareil_inconnu');
  });

  test('un second téléphone du même compte Droplet ID retrouve le solde', async () => {
    const a = appareil(env);
    await a.enregistrer();
    await rechargerEtConfirmer(a, 'g50');
    const b = appareil(env, { compte: a.compte });
    assert.equal((await b.enregistrer()).statut, 200);
    assert.equal((await b.requete('GET', '/v1/moi')).corps.solde, '50');
  });
});

describe('recharges', () => {
  test('le numéro et le palier sont vérifiés, la clé d’idempotence est exigée', async () => {
    const a = appareil(env);
    await a.enregistrer();
    const k = { entetes: { 'Idempotency-Key': 'cle-recharge-1' } };
    assert.equal((await a.requete('POST', '/v1/recharges', { palier: 'g100', operateur: 'mtn', telephone: '12345' }, k)).corps.erreur, 'telephone_invalide');
    assert.equal((await a.requete('POST', '/v1/recharges', { palier: 'g7', operateur: 'mtn', telephone: '699001122' }, k)).corps.erreur, 'palier_inconnu');
    assert.equal((await a.requete('POST', '/v1/recharges', { palier: 'g100', operateur: 'mtn', telephone: '699001122' })).corps.erreur, 'cle_idempotence_requise');
  });

  test('en attente, puis créditée une seule fois malgré dix relectures simultanées', async () => {
    const a = appareil(env);
    await a.enregistrer();
    const r = await a.requete('POST', '/v1/recharges', { palier: 'g100', operateur: 'mtn', telephone: '699001122' }, { entetes: { 'Idempotency-Key': 'unique-1234' } });
    assert.equal(r.corps.etat, 'en_attente');
    assert.equal(r.corps.telephone, '69•••••22');
    const appel = op.appels.find(([t, x]) => t === 'initier' && x.reference === r.corps.id);
    assert.equal(appel[1].telephone, '699001122');
    assert.equal(appel[1].montant, 1000n);

    // Rejouer la même demande ne relance PAS l'opérateur.
    const n = op.appels.length;
    const bis = await a.requete('POST', '/v1/recharges', { palier: 'g100', operateur: 'mtn', telephone: '699001122' }, { entetes: { 'Idempotency-Key': 'unique-1234' } });
    assert.equal(bis.corps.id, r.corps.id);
    assert.equal(op.appels.length, n);

    op.regler(r.corps.id, { etat: 'reussie' });
    await Promise.all(Array.from({ length: 10 }, () => a.requete('GET', `/v1/recharges/${r.corps.id}`)));
    await reconcilier(pool, fournisseursDe(op));
    assert.equal((await a.requete('GET', '/v1/moi')).corps.solde, '100');
  });

  test('un rappel d’opérateur ne crédite rien par lui-même', async () => {
    const a = appareil(env);
    await a.enregistrer();
    const r = await a.requete('POST', '/v1/recharges', { palier: 'g50', operateur: 'mtn', telephone: '677001122' }, { entetes: { 'Idempotency-Key': 'rappel-12345' } });
    // Un faux rappel « SUCCESSFUL » : l'opérateur, lui, dit toujours « en attente ».
    await fetch(`${env.base}/v1/rappels/mtn/${r.corps.id}`, { method: 'PUT', body: JSON.stringify({ status: 'SUCCESSFUL', amount: '500' }) });
    assert.equal((await a.requete('GET', '/v1/moi')).corps.solde, '0');
  });

  test('un montant différent chez l’opérateur ne crédite rien et passe à vérifier', async () => {
    const a = appareil(env);
    await a.enregistrer();
    const r = await a.requete('POST', '/v1/recharges', { palier: 'g500', operateur: 'orange', telephone: '655001122' }, { entetes: { 'Idempotency-Key': 'montant-123' } });
    op.regler(r.corps.id, { etat: 'reussie', montant: 5n });
    const s = await a.requete('GET', `/v1/recharges/${r.corps.id}`);
    assert.equal(s.corps.etat, 'a_verifier');
    assert.equal((await a.requete('GET', '/v1/moi')).corps.solde, '0');
  });

  test('un refus explicite de l’opérateur est un échec ; une coupure est « à vérifier »', async () => {
    const a = appareil(env);
    await a.enregistrer();
    op.reponseInitier = new Error('requesttopay 400');
    const r1 = await a.requete('POST', '/v1/recharges', { palier: 'g50', operateur: 'mtn', telephone: '699001122' }, { entetes: { 'Idempotency-Key': 'refus-1234' } });
    assert.equal(r1.corps.etat, 'echouee');
    op.reponseInitier = new Error('fetch failed');
    const r2 = await a.requete('POST', '/v1/recharges', { palier: 'g50', operateur: 'mtn', telephone: '699001122' }, { entetes: { 'Idempotency-Key': 'coupure-123' } });
    assert.equal(r2.corps.etat, 'a_verifier');
    op.reponseInitier = null;
  });

  test('l’opérateur dit « échouée » : rien n’est crédité', async () => {
    const a = appareil(env);
    await a.enregistrer();
    const r = await a.requete('POST', '/v1/recharges', { palier: 'g50', operateur: 'mtn', telephone: '699001122' }, { entetes: { 'Idempotency-Key': 'echec-1234' } });
    op.regler(r.corps.id, { etat: 'echouee', message: 'APPROVAL_REJECTED' });
    const s = await a.requete('GET', `/v1/recharges/${r.corps.id}`);
    assert.equal(s.corps.etat, 'echouee');
    op.regler(r.corps.id, { etat: 'reussie' }); // même si l'opérateur se ravisait
    assert.equal((await a.requete('GET', `/v1/recharges/${r.corps.id}`)).corps.etat, 'echouee');
    assert.equal((await a.requete('GET', '/v1/moi')).corps.solde, '0');
  });

  test('on ne lit pas la recharge de quelqu’un d’autre', async () => {
    const a = appareil(env);
    const b = appareil(env);
    await a.enregistrer();
    await b.enregistrer();
    const id = await rechargerEtConfirmer(a, 'g50');
    assert.equal((await b.requete('GET', `/v1/recharges/${id}`)).statut, 404);
  });
});

describe('boutique', () => {
  test('solde insuffisant : refusé, et la même clé peut être retentée après recharge', async () => {
    const a = appareil(env);
    await a.enregistrer();
    const k = { entetes: { 'Idempotency-Key': 'achat-pack-1' } };
    assert.equal((await a.requete('POST', '/v1/achats', { produit: 'pack_premium' }, k)).corps.erreur, 'solde_insuffisant');
    await rechargerEtConfirmer(a, 'g100');
    const r = await a.requete('POST', '/v1/achats', { produit: 'pack_premium' }, k);
    assert.equal(r.statut, 200, JSON.stringify(r.corps));
    assert.equal(r.corps.solde, '50');
  });

  test('le reçu est signé et vérifiable hors ligne avec la clé publique', async () => {
    const a = appareil(env);
    await a.enregistrer();
    await rechargerEtConfirmer(a, 'g100');
    const r = await a.requete('POST', '/v1/achats', { produit: 'stickers_gerbes' }, { entetes: { 'Idempotency-Key': 'achat-stick-1' } });
    const recu = lireJeton('DPR1', r.corps.droit.recu, env.cleRecusPub);
    assert.equal(recu.compte, a.compte);
    assert.equal(recu.produit, 'stickers_gerbes');
    assert.equal(recu.fin, null);
    // Un reçu trafiqué (produit remplacé, signature gardée) ne passe pas.
    const [pre, corps, sig] = r.corps.droit.recu.split('.');
    const faux = Buffer.from(Buffer.from(corps, 'base64url').toString().replace('stickers_gerbes', 'pro_365j')).toString('base64url');
    assert.notEqual(faux, corps);
    assert.equal(lireJeton('DPR1', `${pre}.${faux}.${sig}`, env.cleRecusPub), null);
  });

  test('rejouer un achat rend le même résultat et ne débite qu’une fois', async () => {
    const a = appareil(env);
    await a.enregistrer();
    await rechargerEtConfirmer(a, 'g100');
    const k = { entetes: { 'Idempotency-Key': 'achat-rejoue' } };
    const r1 = await a.requete('POST', '/v1/achats', { produit: 'cadeau_goutte_doree' }, k);
    const r2 = await a.requete('POST', '/v1/achats', { produit: 'cadeau_goutte_doree' }, k);
    assert.equal(r2.corps.operation, r1.corps.operation);
    assert.equal((await a.requete('GET', '/v1/moi')).corps.solde, '75');
    assert.equal((await a.requete('POST', '/v1/achats', { produit: 'cadeau_bouquet' }, k)).corps.erreur, 'cle_idempotence_reutilisee');
  });

  test('un produit définitif ne s’achète qu’une fois', async () => {
    const a = appareil(env);
    await a.enregistrer();
    await rechargerEtConfirmer(a, 'g100');
    await a.requete('POST', '/v1/achats', { produit: 'stickers_droplet' }, { entetes: { 'Idempotency-Key': 'def-1-abcd' } });
    assert.equal((await a.requete('POST', '/v1/achats', { produit: 'stickers_droplet' }, { entetes: { 'Idempotency-Key': 'def-2-abcd' } })).corps.erreur, 'deja_possede');
  });

  test('un abonnement acheté deux fois se prolonge au lieu de se recouvrir', async () => {
    // Aucune offre d'abonnement n'est en vente : on teste le mécanisme avec
    // un catalogue d'essai, directement sur la base.
    const a = appareil(env);
    await a.enregistrer();
    await rechargerEtConfirmer(a, 'g250');
    const catalogue = { essai_30j: { famille: 'essai', type: 'abonnement', prix: 100n, jours: 30 } };
    const achat = (cle) => enTransaction(pool, (c) => acheter(c, { compte: a.compte, produit: 'essai_30j', cle, catalogue }));
    const r1 = await achat('abo-1-abcd');
    const r2 = await achat('abo-2-abcd');
    assert.equal(new Date(r2.droit.debut).getTime(), new Date(r1.droit.fin).getTime());
    const jours = (new Date(r2.droit.fin) - new Date(r1.droit.debut)) / 86_400_000;
    assert.ok(Math.abs(jours - 60) < 0.001);
    assert.equal((await a.requete('GET', '/v1/moi')).corps.solde, '60');
  });

  test('offrir Pro à quelqu’un : c’est l’autre qui en profite, et il voit qui l’a offert', async () => {
    const a = appareil(env);
    const b = appareil(env);
    await a.enregistrer();
    await b.enregistrer();
    await rechargerEtConfirmer(a, 'g100');
    const r = await a.requete('POST', '/v1/achats', { produit: 'pro', destinataire: b.compte }, { entetes: { 'Idempotency-Key': 'cadeau-pro-1' } });
    assert.equal(r.statut, 200, JSON.stringify(r.corps));
    assert.equal(r.corps.droit.fin, null);
    const moiB = await b.requete('GET', '/v1/moi');
    assert.equal(moiB.corps.solde, '0');
    assert.equal(moiB.corps.droits[0].produit, 'pro');
    assert.equal(moiB.corps.droits[0].offertPar, a.compte);
    assert.equal((await a.requete('GET', '/v1/moi')).corps.droits.length, 0);
    assert.equal((await a.requete('POST', '/v1/achats', { produit: 'cadeau_bouquet', destinataire: 'compte_inexistant' }, { entetes: { 'Idempotency-Key': 'cadeau-x-12' } })).corps.erreur, 'destinataire_inconnu');
  });

  test('vingt achats simultanés de 25 sur un solde de 100 : quatre passent, jamais de découvert', async () => {
    const a = appareil(env);
    await a.enregistrer();
    await rechargerEtConfirmer(a, 'g100');
    const reps = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      a.requete('POST', '/v1/achats', { produit: 'cadeau_goutte_doree' }, { entetes: { 'Idempotency-Key': `para-${i}-abcd` } })));
    assert.equal(reps.filter((r) => r.statut === 200).length, 4);
    assert.ok(reps.filter((r) => r.statut !== 200).every((r) => r.corps.erreur === 'solde_insuffisant'));
    assert.equal((await a.requete('GET', '/v1/moi')).corps.solde, '0');
  });

  test('l’historique montre la recharge et l’achat, du plus récent au plus ancien', async () => {
    const a = appareil(env);
    await a.enregistrer();
    await rechargerEtConfirmer(a, 'g50');
    await a.requete('POST', '/v1/achats', { produit: 'stickers_personnage' }, { entetes: { 'Idempotency-Key': 'hist-1-abcd' } });
    const h = await a.requete('GET', '/v1/historique?limite=10');
    assert.deepEqual(h.corps.lignes.map((l) => [l.nature, l.montant]), [['achat', '-15'], ['recharge', '50']]);
  });
});

test('à la fin : registre équilibré, journal intact', async () => {
  assert.deepEqual(await verifierRegistre(pool), []);
  assert.equal((await verifierJournal(pool)).ok, true);
});
