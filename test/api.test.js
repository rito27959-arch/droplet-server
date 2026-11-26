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

async function rechargerEtConfirmer(a, palier = 'standard', cle = `r-${Math.random().toString(36).slice(2, 12)}`) {
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
    assert.equal(r.unite, 'dc');
    assert.ok(r.produits.every((p) => typeof p.prix === 'string'));
    assert.ok(r.paliers.find((p) => p.cle === 'starter' && p.credits === '100' && p.montantXaf === '100'));
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
    await rechargerEtConfirmer(a, 'starter');
    const b = appareil(env, { compte: a.compte });
    assert.equal((await b.enregistrer()).statut, 200);
    assert.equal((await b.requete('GET', '/v1/moi')).corps.solde, '100');
  });
});

describe('recharges', () => {
  test('le numéro et le palier sont vérifiés, la clé d’idempotence est exigée', async () => {
    const a = appareil(env);
    await a.enregistrer();
    const k = { entetes: { 'Idempotency-Key': 'cle-recharge-1' } };
    assert.equal((await a.requete('POST', '/v1/recharges', { palier: 'standard', operateur: 'mtn', telephone: '12345' }, k)).corps.erreur, 'telephone_invalide');
    assert.equal((await a.requete('POST', '/v1/recharges', { palier: 'inexistant', operateur: 'mtn', telephone: '699001122' }, k)).corps.erreur, 'palier_inconnu');
    assert.equal((await a.requete('POST', '/v1/recharges', { palier: 'standard', operateur: 'mtn', telephone: '699001122' })).corps.erreur, 'cle_idempotence_requise');
  });

  test('en attente, puis créditée une seule fois malgré dix relectures simultanées', async () => {
    const a = appareil(env);
    await a.enregistrer();
    const r = await a.requete('POST', '/v1/recharges', { palier: 'standard', operateur: 'mtn', telephone: '699001122' }, { entetes: { 'Idempotency-Key': 'unique-1234' } });
    assert.equal(r.corps.etat, 'en_attente');
    assert.equal(r.corps.telephone, '69•••••22');
    const appel = op.appels.find(([t, x]) => t === 'initier' && x.reference === r.corps.id);
    assert.equal(appel[1].telephone, '699001122');
    assert.equal(appel[1].montant, 500n);

    // Rejouer la même demande ne relance PAS l'opérateur.
    const n = op.appels.length;
    const bis = await a.requete('POST', '/v1/recharges', { palier: 'standard', operateur: 'mtn', telephone: '699001122' }, { entetes: { 'Idempotency-Key': 'unique-1234' } });
    assert.equal(bis.corps.id, r.corps.id);
    assert.equal(op.appels.length, n);

    op.regler(r.corps.id, { etat: 'reussie' });
    await Promise.all(Array.from({ length: 10 }, () => a.requete('GET', `/v1/recharges/${r.corps.id}`)));
    await reconcilier(pool, fournisseursDe(op));
    assert.equal((await a.requete('GET', '/v1/moi')).corps.solde, '500');
  });

  test('un rappel d’opérateur ne crédite rien par lui-même', async () => {
    const a = appareil(env);
    await a.enregistrer();
    const r = await a.requete('POST', '/v1/recharges', { palier: 'starter', operateur: 'mtn', telephone: '677001122' }, { entetes: { 'Idempotency-Key': 'rappel-12345' } });
    // Un faux rappel « SUCCESSFUL » : l'opérateur, lui, dit toujours « en attente ».
    await fetch(`${env.base}/v1/rappels/mtn/${r.corps.id}`, { method: 'PUT', body: JSON.stringify({ status: 'SUCCESSFUL', amount: '500' }) });
    assert.equal((await a.requete('GET', '/v1/moi')).corps.solde, '0');
  });

  test('un montant différent chez l’opérateur ne crédite rien et passe à vérifier', async () => {
    const a = appareil(env);
    await a.enregistrer();
    const r = await a.requete('POST', '/v1/recharges', { palier: 'ultimate', operateur: 'orange', telephone: '655001122' }, { entetes: { 'Idempotency-Key': 'montant-123' } });
    op.regler(r.corps.id, { etat: 'reussie', montant: 5n });
    const s = await a.requete('GET', `/v1/recharges/${r.corps.id}`);
    assert.equal(s.corps.etat, 'a_verifier');
    assert.equal((await a.requete('GET', '/v1/moi')).corps.solde, '0');
  });

  test('un refus explicite de l’opérateur est un échec ; une coupure est « à vérifier »', async () => {
    const a = appareil(env);
    await a.enregistrer();
    op.reponseInitier = new Error('requesttopay 400');
    const r1 = await a.requete('POST', '/v1/recharges', { palier: 'starter', operateur: 'mtn', telephone: '699001122' }, { entetes: { 'Idempotency-Key': 'refus-1234' } });
    assert.equal(r1.corps.etat, 'echouee');
    op.reponseInitier = new Error('fetch failed');
    const r2 = await a.requete('POST', '/v1/recharges', { palier: 'starter', operateur: 'mtn', telephone: '699001122' }, { entetes: { 'Idempotency-Key': 'coupure-123' } });
    assert.equal(r2.corps.etat, 'a_verifier');
    op.reponseInitier = null;
  });

  test('l’opérateur dit « échouée » : rien n’est crédité', async () => {
    const a = appareil(env);
    await a.enregistrer();
    const r = await a.requete('POST', '/v1/recharges', { palier: 'starter', operateur: 'mtn', telephone: '699001122' }, { entetes: { 'Idempotency-Key': 'echec-1234' } });
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
    const id = await rechargerEtConfirmer(a, 'starter');
    assert.equal((await b.requete('GET', `/v1/recharges/${id}`)).statut, 404);
  });
});

const achat = (a, produit, cle, extra = {}) =>
  a.requete('POST', '/v1/achats', { produit, ...extra }, { entetes: { 'Idempotency-Key': cle } });
const solde = async (a) => (await a.requete('GET', '/v1/moi')).corps.solde;
const nouveau = async () => {
  const a = appareil(env);
  await a.enregistrer();
  return a;
};

describe('boutique', () => {
  test('le catalogue vient de la base : catégories, collections, brouillons cachés', async () => {
    const r = await fetch(`${env.base}/v1/catalogue`).then((x) => x.json());
    assert.deepEqual(r.categories, ['identite', 'messenger', 'premium', 'collections']);
    assert.ok(r.produits.find((p) => p.cle === 'col_harmattan').articles.includes('theme_sable'));
    assert.equal(r.produits.find((p) => p.cle === 'premium_30j'), undefined);
    assert.equal(r.produits.find((p) => p.cle === 'cadre_goutte').prix, '0');
  });

  test('solde insuffisant : refusé, et la même clé peut être retentée après recharge', async () => {
    const a = await nouveau();
    assert.equal((await achat(a, 'theme_encre', 'achat-theme-1')).corps.erreur, 'solde_insuffisant');
    await rechargerEtConfirmer(a, 'starter');
    const r = await achat(a, 'theme_encre', 'achat-theme-1');
    assert.equal(r.statut, 200, JSON.stringify(r.corps));
    assert.equal(r.corps.solde, '0');
    assert.equal(r.corps.droits[0].produit, 'theme_encre');
  });

  test('le reçu est signé, vérifiable hors ligne, et un reçu trafiqué est refusé', async () => {
    const a = await nouveau();
    await rechargerEtConfirmer(a, 'starter');
    const r = await achat(a, 'stickers_eclat', 'achat-stick-1');
    const recu = lireJeton('DPR1', r.corps.droits[0].recu, env.cleRecusPub);
    assert.equal(recu.compte, a.compte);
    assert.equal(recu.produit, 'stickers_eclat');
    assert.equal(recu.fin, null);
    const [pre, corps, sig] = r.corps.droits[0].recu.split('.');
    const faux = Buffer.from(Buffer.from(corps, 'base64url').toString().replace('stickers_eclat', 'pro')).toString('base64url');
    assert.notEqual(faux, corps);
    assert.equal(lireJeton('DPR1', `${pre}.${faux}.${sig}`, env.cleRecusPub), null);
  });

  test('rejouer un achat rend le même résultat et ne débite qu’une fois', async () => {
    const a = await nouveau();
    await rechargerEtConfirmer(a, 'starter');
    const r1 = await achat(a, 'badge_comete', 'achat-rejoue');
    const r2 = await achat(a, 'badge_comete', 'achat-rejoue');
    assert.equal(r2.corps.operation, r1.corps.operation);
    assert.equal(await solde(a), '50');
    assert.equal((await achat(a, 'badge_feuille', 'achat-rejoue')).corps.erreur, 'cle_idempotence_reutilisee');
  });

  test('un article définitif ne s’achète qu’une fois', async () => {
    const a = await nouveau();
    await rechargerEtConfirmer(a, 'standard');
    assert.equal((await achat(a, 'cadre_orbite', 'def-1-abcd')).statut, 200);
    assert.equal((await achat(a, 'cadre_orbite', 'def-2-abcd')).corps.erreur, 'deja_possede');
    assert.equal(await solde(a), '425');
  });

  test('un article gratuit s’obtient sans DC, une seule fois, et ne s’offre pas', async () => {
    const a = await nouveau();
    const b = await nouveau();
    const r = await achat(a, 'cadre_goutte', 'gratuit-1-ab');
    assert.equal(r.statut, 200, JSON.stringify(r.corps));
    assert.equal(r.corps.operation, null);
    assert.equal(await solde(a), '0');
    assert.equal((await achat(a, 'cadre_goutte', 'gratuit-2-ab')).corps.erreur, 'deja_possede');
    assert.equal((await achat(a, 'cadre_goutte', 'gratuit-3-ab', { destinataire: b.compte })).corps.erreur, 'article_gratuit');
  });

  test('une collection n’apporte que ce qui manque, et ne fait payer que cela si c’est moins cher', async () => {
    const a = await nouveau();
    await rechargerEtConfirmer(a, 'standard');
    await achat(a, 'theme_sable', 'col-pre-1234'); // 100 DC
    const r = await achat(a, 'col_harmattan', 'col-1-abcdef');
    assert.equal(r.statut, 200, JSON.stringify(r.corps));
    // Il manque Sceau (75) + Gravé (60) = 135 DC, moins que 199 : on paie 135.
    assert.equal(r.corps.prix, '135');
    assert.deepEqual(r.corps.droits.map((d) => d.produit).sort(), ['cadre_sceau', 'nom_grave']);
    assert.ok(r.corps.droits.every((d) => d.via === 'col_harmattan'));
    assert.equal(await solde(a), '265');
    assert.equal((await achat(a, 'col_harmattan', 'col-2-abcdef')).corps.erreur, 'deja_possede');
  });

  test('une collection entière coûte son prix, moins que ses articles séparés', async () => {
    const a = await nouveau();
    await rechargerEtConfirmer(a, 'standard');
    const r = await achat(a, 'col_pluies', 'col-3-abcdef');
    assert.equal(r.corps.prix, '199');
    assert.equal(r.corps.droits.length, 3);
    assert.equal(await solde(a), '301');
  });

  test('offrir : c’est l’autre qui reçoit l’article, pas des DC, et il voit qui l’a offert', async () => {
    const a = await nouveau();
    const b = await nouveau();
    await rechargerEtConfirmer(a, 'standard');
    const r = await achat(a, 'theme_lagune', 'cadeau-1-ab', { destinataire: b.compte });
    assert.equal(r.statut, 200, JSON.stringify(r.corps));
    const moiB = (await b.requete('GET', '/v1/moi')).corps;
    assert.equal(moiB.solde, '0');
    assert.equal(moiB.droits[0].produit, 'theme_lagune');
    assert.equal(moiB.droits[0].offertPar, a.compte);
    assert.equal((await a.requete('GET', '/v1/moi')).corps.droits.length, 0);
    assert.equal((await achat(a, 'theme_lagune', 'cadeau-2-ab', { destinataire: b.compte })).corps.erreur, 'deja_possede');
    assert.equal((await achat(a, 'badge_comete', 'cadeau-3-ab', { destinataire: 'compte_inexistant' })).corps.erreur, 'destinataire_inconnu');
  });

  test('vingt achats simultanés de 50 DC sur un solde de 100 : deux passent, jamais de découvert', async () => {
    const a = await nouveau();
    const b = await nouveau();
    await rechargerEtConfirmer(a, 'starter');
    // Des cadeaux différents à des personnes différentes : seul le solde limite.
    const destinataires = [];
    for (let i = 0; i < 20; i++) destinataires.push((await nouveau()).compte);
    const reps = await Promise.all(destinataires.map((d, i) => achat(a, 'badge_comete', `para-${i}-abcd`, { destinataire: d })));
    assert.equal(reps.filter((r) => r.statut === 200).length, 2);
    assert.ok(reps.filter((r) => r.statut !== 200).every((r) => r.corps.erreur === 'solde_insuffisant'));
    assert.equal(await solde(a), '0');
    void b;
  });

  test('le même article définitif acheté deux fois en même temps : un seul passe', async () => {
    const a = await nouveau();
    await rechargerEtConfirmer(a, 'standard');
    const reps = await Promise.all(Array.from({ length: 8 }, (_, i) => achat(a, 'cadre_prisme', `double-${i}-abcd`)));
    assert.equal(reps.filter((r) => r.statut === 200).length, 1);
    assert.equal(await solde(a), '425');
  });

  test('l’historique montre la recharge et l’achat, du plus récent au plus ancien', async () => {
    const a = await nouveau();
    await rechargerEtConfirmer(a, 'starter');
    await achat(a, 'nom_mono', 'hist-1-abcd');
    const h = await a.requete('GET', '/v1/historique?limite=10');
    assert.deepEqual(h.corps.lignes.map((l) => [l.nature, l.montant]), [['achat', '-60'], ['recharge', '100']]);
  });

  test('un abonnement acheté deux fois se prolonge (catalogue d’essai)', async () => {
    const a = await nouveau();
    await rechargerEtConfirmer(a, 'standard');
    const catalogue = { essai_30j: { type: 'abonnement', prix: 100, jours: 30 } };
    const f = (cle) => enTransaction(pool, (c) => acheter(c, { compte: a.compte, produit: 'essai_30j', cle, catalogue }));
    const r1 = await f('abo-1-abcd');
    const r2 = await f('abo-2-abcd');
    assert.equal(new Date(r2.droits[0].debut).getTime(), new Date(r1.droits[0].fin).getTime());
    assert.ok(Math.abs((new Date(r2.droits[0].fin) - new Date(r1.droits[0].debut)) / 86_400_000 - 60) < 0.001);
    assert.equal(await solde(a), '300');
  });
});

describe('administration', () => {
  const jeton = 'jeton-admin-de-test-0123456789abcdefghijkl';
  const admin = (methode, chemin, corps, j = jeton) =>
    fetch(env.base + chemin, { method: methode, headers: { Authorization: `Bearer ${j}`, 'Content-Type': 'application/json' }, body: corps ? JSON.stringify(corps) : undefined })
      .then(async (r) => ({ statut: r.status, corps: await r.json() }));

  test('sans le bon jeton : rien', async () => {
    assert.equal((await admin('GET', '/admin/v1/tableau', undefined, 'mauvais-jeton-mauvais-jeton-mauvais')).statut, 401);
    assert.equal((await fetch(`${env.base}/admin/v1/tableau`)).status, 401);
  });

  test('changer un prix : effet immédiat, historique gardé pour comparer les ventes', async () => {
    assert.equal((await admin('PATCH', '/admin/v1/produits/badge_feuille', { prix: 40 })).statut, 200);
    const cat = await fetch(`${env.base}/v1/catalogue`).then((x) => x.json());
    assert.equal(cat.produits.find((p) => p.cle === 'badge_feuille').prix, '40');
    const h = await admin('GET', '/admin/v1/produits/badge_feuille/prix');
    assert.deepEqual(h.corps.periodes.map((x) => x.prix), ['50', '40']);
    assert.equal((await admin('PATCH', '/admin/v1/produits/badge_feuille', { prix: -3 })).corps.erreur, 'prix_invalide');
  });

  test('publier un brouillon, retirer un article', async () => {
    await admin('PATCH', '/admin/v1/produits/premium_30j', { statut: 'publie' });
    let cat = await fetch(`${env.base}/v1/catalogue`).then((x) => x.json());
    assert.equal(cat.produits.find((p) => p.cle === 'premium_30j').jours, 30);
    await admin('PATCH', '/admin/v1/produits/premium_30j', { statut: 'brouillon' });
    cat = await fetch(`${env.base}/v1/catalogue`).then((x) => x.json());
    assert.equal(cat.produits.find((p) => p.cle === 'premium_30j'), undefined);
  });

  test('ajouter un article : genre connu, nom français exigé', async () => {
    const ok = await admin('POST', '/admin/v1/produits', { cle: 'cadre_test', categorie: 'identite', genre: 'cadre', prix: 30, statut: 'publie', donnees: { motif: 'goutte', nom: { fr: 'Essai' } } });
    assert.equal(ok.statut, 201, JSON.stringify(ok.corps));
    assert.equal((await admin('POST', '/admin/v1/produits', { cle: 'son_x', categorie: 'messenger', genre: 'son', prix: 30, donnees: { nom: { fr: 'x' } } })).corps.erreur, 'genre_inconnu');
    assert.equal((await admin('POST', '/admin/v1/produits', { cle: 'cadre_test', categorie: 'identite', genre: 'cadre', prix: 30, donnees: { nom: { fr: 'x' } } })).corps.erreur, 'cle_existante');
  });

  test('rembourser un achat : DC rendus, article retiré, une seule fois', async () => {
    const a = await nouveau();
    await rechargerEtConfirmer(a, 'starter');
    const r = await achat(a, 'nom_grave', 'remb-1-abcd');
    assert.equal(await solde(a), '40');
    assert.equal((await admin('POST', '/admin/v1/remboursements', { operation: r.corps.operation })).corps.erreur, 'motif_requis');
    const rb = await admin('POST', '/admin/v1/remboursements', { operation: r.corps.operation, motif: 'acheté par erreur' });
    assert.equal(rb.statut, 200, JSON.stringify(rb.corps));
    assert.deepEqual(rb.corps.droitsRetires, ['nom_grave']);
    assert.equal(await solde(a), '100');
    assert.equal((await a.requete('GET', '/v1/moi')).corps.droits.length, 0);
    assert.equal((await admin('POST', '/admin/v1/remboursements', { operation: r.corps.operation, motif: 'encore' })).corps.erreur, 'deja_rembourse');
    // Et l'article peut être racheté.
    assert.equal((await achat(a, 'nom_grave', 'remb-2-abcd')).statut, 200);
  });

  test('l’administration ne peut pas créditer un portefeuille à la main', async () => {
    assert.equal((await admin('POST', '/admin/v1/credits', { compte: 'x', montant: 1000 })).statut, 404);
  });

  test('créateurs : un article en revue n’est pas en vente avant publication', async () => {
    await admin('POST', '/admin/v1/createurs', { id: 'atelier_test', nomPublic: 'Atelier Test' });
    await admin('POST', '/admin/v1/produits', { cle: 'cadre_atelier', categorie: 'identite', genre: 'cadre', prix: 80, createur: 'atelier_test', statut: 'en_revue', donnees: { motif: 'sceau', nom: { fr: 'Atelier' } } });
    let cat = await fetch(`${env.base}/v1/catalogue`).then((x) => x.json());
    assert.equal(cat.produits.find((p) => p.cle === 'cadre_atelier'), undefined);
    assert.ok((await admin('GET', '/admin/v1/moderation')).corps.aRevoir.some((p) => p.cle === 'cadre_atelier'));
    assert.equal((await admin('POST', '/admin/v1/moderation/cadre_atelier', { decision: 'refuser' })).corps.erreur, 'motif_requis');
    await admin('POST', '/admin/v1/moderation/cadre_atelier', { decision: 'publier' });
    cat = await fetch(`${env.base}/v1/catalogue`).then((x) => x.json());
    assert.deepEqual(cat.produits.find((p) => p.cle === 'cadre_atelier').createur, { id: 'atelier_test', nom: 'Atelier Test' });
    await admin('PATCH', '/admin/v1/createurs/atelier_test', { statut: 'suspendu' });
    cat = await fetch(`${env.base}/v1/catalogue`).then((x) => x.json());
    assert.equal(cat.produits.find((p) => p.cle === 'cadre_atelier'), undefined);
  });

  test('tableau de bord, signaux suspects, intégrité', async () => {
    const t = await admin('GET', '/admin/v1/tableau');
    assert.ok(t.corps.ventes30j.achats > 0);
    assert.ok(Array.isArray((await admin('GET', '/admin/v1/suspects')).corps.signaux));
    const i = await admin('GET', '/admin/v1/integrite');
    assert.deepEqual(i.corps.registre, []);
    assert.equal(i.corps.journal.ok, true);
  });
});

test('à la fin : registre équilibré, journal intact', async () => {
  assert.deepEqual(await verifierRegistre(pool), []);
  assert.equal((await verifierJournal(pool)).ok, true);
});
