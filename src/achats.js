// ============================================================================
// LES ACHATS — des DC contre des articles du Droplet Store.
// ----------------------------------------------------------------------------
// Un achat est UNE transaction : débit du portefeuille, crédit du compte
// « produits », création des droits, ligne de journal. Si le solde ne suffit
// pas, la base refuse l'écriture et rien d'autre n'a lieu.
//
// Trois protections contre le double achat, de la plus haute à la plus basse :
//   1. la clé d'idempotence de la requête (table `idempotence`) ;
//   2. la référence de l'opération `achat:<compte>:<clé>` (unique) ;
//   3. l'index unique « un article définitif, une fois » sur `droits`.
//
// Une collection n'accorde que les articles qu'on n'a pas encore, et ne fait
// payer que ceux-là si leur total est inférieur à son prix.
// On peut acheter pour quelqu'un (un cadeau) : on offre un ARTICLE, jamais
// des DC.
// ============================================================================

import { randomUUID } from 'node:crypto';

import { lireProduit } from './catalogue.js';
import { signerJeton } from './jetons.js';
import { journaliser } from './journal.js';
import { codePortefeuille, ErreurMetier, passerOperation } from './registre.js';

const JOUR_MS = 86_400_000;

export function recuDroit(droit, clePrivee) {
  if (!clePrivee) return null;
  return signerJeton('DPR1', {
    v: 1,
    id: droit.id,
    compte: droit.compte,
    produit: droit.produit,
    debut: Math.floor(new Date(droit.debut).getTime() / 1000),
    fin: droit.fin ? Math.floor(new Date(droit.fin).getTime() / 1000) : null,
  }, clePrivee);
}

export function exposerDroit(d, clePrivee) {
  return {
    id: d.id,
    produit: d.produit,
    debut: d.debut,
    fin: d.fin,
    via: d.via ?? null,
    offertPar: d.offert_par ?? null,
    recu: recuDroit(d, clePrivee),
  };
}

async function possedes(c, compte, cles) {
  const r = await c.query(
    `select produit from droits where compte = $1 and produit = any($2) and revoque_le is null and (fin is null or fin > now())`,
    [compte, cles],
  );
  return new Set(r.rows.map((x) => x.produit));
}

/**
 * `cle` est la clé d'idempotence de la requête : elle entre dans la
 * référence de l'opération, si bien qu'un achat rejoué ne débite pas deux
 * fois, même si la table d'idempotence avait été contournée.
 */
export async function acheter(c, { compte, produit, destinataire = null, cle, clePrivee, catalogue = null }) {
  if (!cle) throw new ErreurMetier('cle_idempotence_requise');
  if (destinataire === compte) destinataire = null;
  const beneficiaire = destinataire ?? compte;
  const reference = `achat:${compte}:${cle}`;

  // Requête rejouée : on rend le premier résultat, avant tout autre contrôle.
  const anterieur = await c.query(
    'select d.*, o.id as op, o.details from operations o join droits d on d.operation = o.id where o.reference = $1',
    [reference],
  );
  if (anterieur.rowCount) {
    if (anterieur.rows[0].details.produit !== produit) throw new ErreurMetier('cle_idempotence_reutilisee', 422);
    return { operation: anterieur.rows[0].op, droits: anterieur.rows.map((d) => exposerDroit(d, clePrivee)), deja: true };
  }

  const p = catalogue ? catalogue[produit] && { cle: produit, ...catalogue[produit], prix: BigInt(catalogue[produit].prix) } : await lireProduit(c, produit);
  if (!p) throw new ErreurMetier('produit_inconnu', 404);

  if (destinataire) {
    const ex = await c.query('select 1 from comptes where id = $1', [destinataire]);
    if (!ex.rowCount) throw new ErreurMetier('destinataire_inconnu', 404);
    if (BigInt(p.prix) === 0n) throw new ErreurMetier('article_gratuit', 422);
  }

  // Le compte du bénéficiaire est verrouillé : deux achats simultanés pour
  // la même personne passent l'un après l'autre.
  await c.query('select 1 from comptes where id = $1 for update', [beneficiaire]);

  // Ce qu'on va accorder, et à quel prix.
  let lignes = [];
  let prix = BigInt(p.prix);
  if (p.type === 'collection') {
    const deja = await possedes(c, beneficiaire, p.articles);
    const manquants = [];
    for (const a of p.articles) {
      if (deja.has(a)) continue;
      const art = await lireProduit(c, a);
      if (!art) throw new ErreurMetier('collection_incomplete', 409);
      manquants.push(art);
    }
    if (!manquants.length) throw new ErreurMetier('deja_possede', 409);
    const somme = manquants.reduce((s, a) => s + BigInt(a.prix), 0n);
    if (somme < prix) prix = somme;
    lignes = manquants.map((a) => ({ produit: a.cle, fin: null, via: p.cle }));
  } else if (p.type === 'abonnement') {
    const cours = await c.query(
      'select max(fin) as fin from droits where compte = $1 and produit = $2 and revoque_le is null',
      [beneficiaire, p.cle],
    );
    const maintenant = new Date();
    const finActuelle = cours.rows[0].fin ? new Date(cours.rows[0].fin) : null;
    const debut = finActuelle && finActuelle > maintenant ? finActuelle : maintenant;
    lignes = [{ produit: p.cle, debut, fin: new Date(debut.getTime() + p.jours * JOUR_MS), via: null }];
  } else {
    if ((await possedes(c, beneficiaire, [p.cle])).has(p.cle)) throw new ErreurMetier('deja_possede', 409);
    lignes = [{ produit: p.cle, fin: null, via: null }];
  }

  let operation = null;
  if (prix > 0n) {
    const op = await passerOperation(c, {
      nature: destinataire ? 'cadeau' : 'achat',
      reference,
      details: { produit: p.cle, prix: prix.toString(), ...(destinataire ? { destinataire } : {}) },
      lignes: [
        { code: codePortefeuille(compte), nature: 'portefeuille', compte, montant: -prix },
        { code: 'produits', nature: 'produits', montant: prix },
      ],
    });
    operation = op.id;
  }

  const droits = [];
  try {
    for (const l of lignes) {
      const d = await c.query(
        `insert into droits (id, compte, produit, debut, fin, operation, via, offert_par)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [randomUUID(), beneficiaire, l.produit, l.debut ?? new Date(), l.fin, operation, l.via, destinataire ? compte : null],
      );
      droits.push(exposerDroit(d.rows[0], clePrivee));
    }
  } catch (e) {
    // Deux achats simultanés du même article définitif : la base a tranché.
    if (e.code === '23505') throw new ErreurMetier('deja_possede', 409);
    throw e;
  }
  await journaliser(c, compte, prix > 0n ? (destinataire ? 'achat.cadeau' : 'achat') : 'achat.gratuit', {
    operation, produit: p.cle, prix, ...(destinataire ? { destinataire } : {}),
  });
  return { operation, droits, prix: prix.toString(), deja: false };
}

/**
 * Rembourse un achat : écriture inverse (une seule fois, référence unique)
 * et retrait des droits qu'il avait accordés. Réservé à l'administration.
 */
export async function rembourser(c, { operation, motif, acteur = 'admin' }) {
  const o = await c.query("select * from operations where id = $1 and nature in ('achat', 'cadeau')", [operation]);
  if (!o.rowCount) throw new ErreurMetier('operation_inconnue', 404);
  const lignes = await c.query(
    `select cr.code, cr.nature, cr.compte, e.montant from ecritures e join comptes_registre cr on cr.id = e.compte_registre
      where e.operation = $1`,
    [operation],
  );
  const r = await passerOperation(c, {
    nature: 'remboursement',
    reference: `remboursement:${operation}`,
    details: { operation, motif: String(motif ?? '').slice(0, 200) },
    lignes: lignes.rows.map((l) => ({ code: l.code, nature: l.nature, compte: l.compte, montant: -BigInt(l.montant) })),
  });
  if (r.deja) throw new ErreurMetier('deja_rembourse', 409);
  const rev = await c.query('update droits set revoque_le = now() where operation = $1 and revoque_le is null returning produit', [operation]);
  await journaliser(c, acteur, 'remboursement', { operation, remboursement: r.id, droits: rev.rowCount, motif: String(motif ?? '').slice(0, 200) });
  return { remboursement: r.id, droitsRetires: rev.rows.map((x) => x.produit) };
}

export async function droitsActifs(c, compte, clePrivee) {
  const r = await c.query(
    `select * from droits where compte = $1 and revoque_le is null and (fin is null or fin > now()) order by cree_le desc`,
    [compte],
  );
  return r.rows.map((d) => exposerDroit(d, clePrivee));
}
