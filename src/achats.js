// ============================================================================
// LES ACHATS — des Gouttes contre un produit du catalogue.
// ----------------------------------------------------------------------------
// Un achat est UNE transaction : débit du portefeuille, crédit du compte
// « produits », création du droit, ligne de journal. Si le solde ne suffit
// pas, la base refuse l'écriture et rien d'autre n'a lieu.
//
// On peut acheter pour soi ou pour quelqu'un d'autre (un cadeau). Le
// destinataire est désigné par son identifiant Droplet Pay ; il doit exister.
// ============================================================================

import { randomUUID } from 'node:crypto';

import { PRODUITS } from './catalogue.js';
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
    offertPar: d.offert_par ?? null,
    recu: recuDroit(d, clePrivee),
  };
}

/**
 * `cle` est la clé d'idempotence de la requête : elle entre dans la
 * référence de l'opération, si bien qu'un achat rejoué ne débite pas deux
 * fois, même si la table d'idempotence avait été contournée.
 */
export async function acheter(c, { compte, produit, destinataire = null, cle, clePrivee }) {
  const p = PRODUITS[produit];
  if (!p) throw new ErreurMetier('produit_inconnu');
  if (!cle) throw new ErreurMetier('cle_idempotence_requise');
  const beneficiaire = destinataire ?? compte;

  // Requête rejouée : on rend le premier résultat, avant tout autre contrôle
  // (sinon un achat définitif rejoué répondrait « déjà possédé »).
  const anterieur = await c.query(
    'select d.* , o.id as op from operations o join droits d on d.operation = o.id where o.reference = $1',
    [`achat:${compte}:${cle}`],
  );
  if (anterieur.rowCount) {
    const d = anterieur.rows[0];
    if (d.produit !== produit) throw new ErreurMetier('cle_idempotence_reutilisee', 422);
    return { operation: d.op, droit: exposerDroit(d, clePrivee), deja: true };
  }

  if (destinataire) {
    const ex = await c.query('select 1 from comptes where id = $1', [destinataire]);
    if (!ex.rowCount) throw new ErreurMetier('destinataire_inconnu', 404);
  }

  // Le compte du bénéficiaire est verrouillé : deux achats d'abonnement
  // simultanés se prolongent l'un après l'autre au lieu de se recouvrir.
  await c.query('select 1 from comptes where id = $1 for update', [beneficiaire]);

  if (p.type === 'definitif') {
    const deja = await c.query('select 1 from droits where compte = $1 and produit = $2', [beneficiaire, produit]);
    if (deja.rowCount) throw new ErreurMetier('deja_possede', 409);
  }

  const maintenant = new Date();
  let debut = maintenant;
  let fin = null;
  if (p.type === 'abonnement') {
    const memeFamille = Object.keys(PRODUITS).filter((k) => PRODUITS[k].famille === p.famille && PRODUITS[k].type === 'abonnement');
    const cours = await c.query('select max(fin) as fin from droits where compte = $1 and produit = any($2)', [beneficiaire, memeFamille]);
    const finActuelle = cours.rows[0].fin ? new Date(cours.rows[0].fin) : null;
    if (finActuelle && finActuelle > maintenant) debut = finActuelle;
    fin = new Date(debut.getTime() + p.jours * JOUR_MS);
  }

  const op = await passerOperation(c, {
    nature: destinataire ? 'cadeau' : 'achat',
    reference: `achat:${compte}:${cle}`,
    details: { produit, prix: p.prix.toString(), ...(destinataire ? { destinataire } : {}) },
    lignes: [
      { code: codePortefeuille(compte), nature: 'portefeuille', compte, montant: -p.prix },
      { code: 'produits', nature: 'produits', montant: p.prix },
    ],
  });
  if (op.deja) {
    const d = await c.query('select * from droits where operation = $1', [op.id]);
    return { operation: op.id, droit: exposerDroit(d.rows[0], clePrivee), deja: true };
  }

  const d = await c.query(
    `insert into droits (id, compte, produit, debut, fin, operation, offert_par)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [randomUUID(), beneficiaire, produit, debut, fin, op.id, destinataire ? compte : null],
  );
  await journaliser(c, compte, destinataire ? 'achat.cadeau' : 'achat', { operation: op.id, produit, prix: p.prix });
  return { operation: op.id, droit: exposerDroit(d.rows[0], clePrivee), deja: false };
}

export async function droitsActifs(c, compte, clePrivee) {
  const r = await c.query(
    `select * from droits where compte = $1 and (fin is null or fin > now()) order by cree_le desc`,
    [compte],
  );
  return r.rows.map((d) => exposerDroit(d, clePrivee));
}
