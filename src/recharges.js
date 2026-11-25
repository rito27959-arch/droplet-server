// ============================================================================
// LES RECHARGES — de l'argent Mobile Money vers des Gouttes.
// ----------------------------------------------------------------------------
// Le parcours :
//
//   creee ──initier()──▶ en_attente ──statut()=reussie──▶ reussie  (+ Gouttes)
//                          │                  └─────────▶ echouee
//                          └── trop long, ou réponse douteuse ──▶ a_verifier
//
// ⚠️ TROIS RÈGLES, QUI VALENT CHACUNE UNE PERTE D'ARGENT SI ON LES OUBLIE :
//
//   1. On ne crédite que sur la parole de l'OPÉRATEUR, relue par nous
//      (statut()), jamais sur celle de l'app, ni sur le corps d'un rappel.
//   2. Un délai dépassé n'est PAS un échec : l'argent peut être parti. La
//      recharge passe « à vérifier » et reste relue ; seul l'opérateur peut
//      dire « échouée ».
//   3. On crédite UNE fois : l'opération porte la référence `recharge:<id>`,
//      unique dans la base. Deux relectures simultanées, un rappel et la
//      réconciliation en même temps : une seule écriture passe.
// ============================================================================

import { randomUUID } from 'node:crypto';

import { PALIERS } from './catalogue.js';
import { enTransaction } from './db.js';
import { masquer, numeroLocal } from './fournisseurs/telephone.js';
import { journaliser } from './journal.js';
import { codePortefeuille, ErreurMetier, passerOperation } from './registre.js';

export function exposerRecharge(r) {
  return {
    id: r.id,
    palier: r.palier,
    montantXaf: r.montant_xaf.toString(),
    gouttes: r.gouttes.toString(),
    operateurFournisseur: r.fournisseur,
    telephone: r.telephone_masque,
    etat: r.etat,
    message: r.message ?? null,
    creeLe: r.cree_le,
  };
}

export async function creerRecharge(pool, fournisseurs, { compte, palier, operateur, telephone }) {
  const p = PALIERS[palier];
  if (!p) throw new ErreurMetier('palier_inconnu');
  const local = numeroLocal(telephone);
  if (!local) throw new ErreurMetier('telephone_invalide');
  const f = fournisseurs.pour(operateur);
  if (!f) throw new ErreurMetier('operateur_indisponible', 503);
  if (f.minimum && p.montantXaf < f.minimum) throw new ErreurMetier('montant_sous_minimum');

  const id = randomUUID();
  // MTN prend NOTRE identifiant comme référence (X-Reference-Id) : on la
  // connaît avant même l'appel, et on peut relire le statut même si la
  // réponse s'est perdue en route.
  const refAvance = f.nom === 'mtn' ? id : null;

  const r = await enTransaction(pool, async (c) => {
    const ins = await c.query(
      `insert into recharges (id, compte, palier, montant_xaf, gouttes, fournisseur, devise, telephone_masque, ref_fournisseur, etat)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'creee') returning *`,
      [id, compte, palier, p.montantXaf.toString(), p.gouttes.toString(), f.nom, f.devise, masquer(local), refAvance],
    );
    await journaliser(c, compte, 'recharge.creee', { recharge: id, palier, fournisseur: f.nom });
    return ins.rows[0];
  });

  let maj;
  try {
    const { refFournisseur } = await f.initier({ reference: id, montant: p.montantXaf, telephone: local, description: 'Droplet — Gouttes' });
    maj = { etat: 'en_attente', ref: refFournisseur, message: null };
  } catch (e) {
    // Réponse explicite de l'opérateur (« numéro invalide ») : rien n'est
    // parti. Coupure réseau : on ne sait pas — à vérifier, si l'on peut.
    // Seul un refus 4xx est un « non » certain. Un 5xx peut cacher une
    // demande partie quand même.
    const explicite = /\b4\d\d\b/.test(e.message ?? '');
    maj = explicite
      ? { etat: 'echouee', ref: refAvance, message: String(e.message ?? 'erreur').slice(0, 200) }
      : { etat: 'a_verifier', ref: refAvance, message: 'réponse de l’opérateur perdue' };
  }

  return enTransaction(pool, async (c) => {
    const u = await c.query(
      `update recharges set etat = $2, ref_fournisseur = coalesce($3, ref_fournisseur), message = $4, maj_le = now()
        where id = $1 and etat = 'creee' returning *`,
      [id, maj.etat, maj.ref, maj.message],
    );
    await journaliser(c, compte, `recharge.${maj.etat}`, { recharge: id });
    return exposerRecharge(u.rows[0] ?? r);
  });
}

/**
 * Relit une recharge chez l'opérateur et en tire les conséquences.
 * Sans effet sur une recharge déjà terminée.
 */
export async function actualiserRecharge(pool, fournisseurs, id, { delaiVerificationMinutes = 60 } = {}) {
  const lue = await pool.query('select * from recharges where id = $1', [id]);
  const r = lue.rows[0];
  if (!r) throw new ErreurMetier('recharge_inconnue', 404);
  if (r.etat === 'reussie' || r.etat === 'echouee' || !r.ref_fournisseur) return exposerRecharge(r);

  const f = fournisseurs.par(r.fournisseur);
  let s;
  try {
    s = await f.statut(r.ref_fournisseur, r.id);
  } catch (e) {
    s = { etat: 'inconnu', message: String(e.message).slice(0, 200) };
  }

  if (s.etat === 'reussie') {
    // Le montant et la devise relus chez l'opérateur doivent être ceux que
    // nous avons demandés. Sinon, on ne crédite rien et un humain regarde.
    const montantFaux = s.montant !== null && s.montant !== undefined && s.montant !== r.montant_xaf;
    const deviseFausse = s.devise && s.devise !== r.devise;
    if (montantFaux || deviseFausse) {
      return marquer(pool, r, 'a_verifier', `montant ou devise inattendus (${s.montant} ${s.devise})`);
    }
    return enTransaction(pool, async (c) => {
      const op = await passerOperation(c, {
        nature: 'recharge',
        reference: `recharge:${r.id}`,
        details: { recharge: r.id, fournisseur: r.fournisseur, montantXaf: r.montant_xaf.toString(), devise: r.devise },
        lignes: [
          { code: `compensation:${r.fournisseur}`, nature: 'compensation', montant: -r.gouttes },
          { code: codePortefeuille(r.compte), nature: 'portefeuille', compte: r.compte, montant: r.gouttes },
        ],
      });
      const u = await c.query(
        `update recharges set etat = 'reussie', message = null, maj_le = now() where id = $1 and etat <> 'reussie' returning *`,
        [r.id],
      );
      if (!op.deja) await journaliser(c, 'systeme', 'recharge.reussie', { recharge: r.id, gouttes: r.gouttes, operation: op.id });
      return exposerRecharge(u.rows[0] ?? { ...r, etat: 'reussie' });
    });
  }

  if (s.etat === 'echouee') return marquer(pool, r, 'echouee', s.message);

  const age = (Date.now() - new Date(r.cree_le).getTime()) / 60000;
  if (r.etat === 'en_attente' && (s.etat === 'inconnu' || age > delaiVerificationMinutes)) {
    return marquer(pool, r, 'a_verifier', s.message ?? 'toujours en attente');
  }
  return exposerRecharge(r);
}

async function marquer(pool, r, etat, message) {
  return enTransaction(pool, async (c) => {
    const u = await c.query(
      `update recharges set etat = $2, message = $3, maj_le = now()
        where id = $1 and etat in ('creee', 'en_attente', 'a_verifier') returning *`,
      [r.id, etat, message ? String(message).slice(0, 200) : null],
    );
    if (u.rowCount && etat !== r.etat) await journaliser(c, 'systeme', `recharge.${etat}`, { recharge: r.id });
    return exposerRecharge(u.rows[0] ?? r);
  });
}

/** La réconciliation : relit tout ce qui n'est pas terminé. */
export async function reconcilier(pool, fournisseurs, options = {}) {
  const r = await pool.query(
    `select id from recharges
      where etat in ('en_attente', 'a_verifier') and ref_fournisseur is not null
        and maj_le < now() - interval '10 seconds'
      order by maj_le limit 50`,
  );
  const resultats = [];
  for (const { id } of r.rows) resultats.push(await actualiserRecharge(pool, fournisseurs, id, options));
  return resultats;
}
