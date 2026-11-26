// ============================================================================
// LE REGISTRE — la comptabilité en partie double des Droplet Credits (DC).
// ----------------------------------------------------------------------------
// Une opération = un fait réel (une recharge confirmée, un achat). Elle écrit
// au moins deux lignes dont la somme est nulle :
//
//   recharge confirmée   compensation:mtn  −100    portefeuille:ana  +100
//   achat d'un fond      portefeuille:ana   −10    produits           +10
//
// Le solde d'un compte est la somme de ses lignes ; il est aussi tenu dans
// `comptes_registre.solde` par la base elle-même, dans la même transaction,
// ce qui laisse à PostgreSQL le soin de refuser un découvert.
// ============================================================================

import { randomUUID } from 'node:crypto';

export class ErreurMetier extends Error {
  constructor(code, statut = 400, details) {
    super(code);
    this.code = code;
    this.statut = statut;
    this.details = details;
  }
}

export const codePortefeuille = (compte) => `portefeuille:${compte}`;

export async function assurerCompteRegistre(c, code, nature, compte = null) {
  // `do nothing` plutôt que `do update` : on ne verrouille pas la ligne ici.
  // Les verrous se prennent plus loin, dans un ordre fixe (voir plus bas).
  const r = await c.query(
    `insert into comptes_registre (code, nature, compte) values ($1, $2, $3)
     on conflict (code) do nothing returning id`,
    [code, nature, compte],
  );
  if (r.rowCount) return r.rows[0].id;
  const ex = await c.query('select id, nature from comptes_registre where code = $1', [code]);
  if (ex.rows[0].nature !== nature) throw new Error(`compte ${code} : nature ${ex.rows[0].nature}, pas ${nature}`);
  return ex.rows[0].id;
}

/**
 * Passe une opération. Si une opération de même `reference` existe déjà,
 * rien n'est écrit et `{ deja: true }` est rendu : c'est ce qui rend un
 * double rappel d'opérateur, ou une requête rejouée, sans effet.
 */
export async function passerOperation(c, { nature, reference, details = {}, lignes }) {
  const total = lignes.reduce((s, l) => s + BigInt(l.montant), 0n);
  if (total !== 0n) throw new Error(`opération déséquilibrée : ${total}`);
  if (lignes.some((l) => BigInt(l.montant) === 0n)) throw new Error('ligne nulle');

  const id = randomUUID();
  const ins = await c.query(
    `insert into operations (id, nature, reference, details) values ($1, $2, $3, $4)
     on conflict (reference) do nothing returning id`,
    [id, nature, reference, details],
  );
  if (ins.rowCount === 0) {
    const ex = await c.query('select id from operations where reference = $1', [reference]);
    return { id: ex.rows[0].id, deja: true };
  }

  // Les comptes sont résolus puis écrits dans l'ordre de leur identifiant :
  // deux opérations concurrentes verrouillent donc toujours dans le même
  // ordre, et ne peuvent pas s'interbloquer.
  const resolues = [];
  for (const l of lignes) {
    resolues.push({ idCompte: await assurerCompteRegistre(c, l.code, l.nature, l.compte ?? null), montant: BigInt(l.montant) });
  }
  resolues.sort((a, b) => (a.idCompte < b.idCompte ? -1 : 1));

  try {
    for (const l of resolues) {
      await c.query('insert into ecritures (operation, compte_registre, montant) values ($1, $2, $3)', [id, l.idCompte, l.montant.toString()]);
    }
  } catch (e) {
    if (e.code === '23514' && e.constraint === 'pas_de_decouvert') {
      throw new ErreurMetier('solde_insuffisant', 409);
    }
    throw e;
  }
  return { id, deja: false };
}

export async function solde(c, compte) {
  const r = await c.query('select solde from comptes_registre where code = $1', [codePortefeuille(compte)]);
  return r.rowCount ? r.rows[0].solde : 0n;
}

/** L'historique d'un portefeuille, le plus récent d'abord. */
export async function historique(c, compte, { avant = null, limite = 30 } = {}) {
  const r = await c.query(
    `select e.id, e.montant, o.id as operation, o.nature, o.cree_le, o.details
       from ecritures e
       join comptes_registre cr on cr.id = e.compte_registre
       join operations o on o.id = e.operation
      where cr.code = $1 and ($2::bigint is null or e.id < $2)
      order by e.id desc
      limit $3`,
    [codePortefeuille(compte), avant, Math.min(Math.max(limite, 1), 100)],
  );
  return r.rows;
}

/**
 * Contrôle d'intégrité : chaque solde égale la somme de ses lignes, et la
 * somme de tout le registre est nulle. Rend la liste des anomalies.
 */
export async function verifierRegistre(c) {
  const anomalies = [];
  const ecarts = await c.query(
    `select cr.code, cr.solde, coalesce(sum(e.montant), 0) as somme
       from comptes_registre cr left join ecritures e on e.compte_registre = cr.id
      group by cr.id having cr.solde <> coalesce(sum(e.montant), 0)`,
  );
  for (const r of ecarts.rows) anomalies.push({ type: 'solde_incoherent', ...r });
  const total = await c.query('select coalesce(sum(montant), 0) as t from ecritures');
  if (BigInt(total.rows[0].t) !== 0n) anomalies.push({ type: 'registre_desequilibre', total: total.rows[0].t });
  const ops = await c.query(
    'select operation, sum(montant) as s from ecritures group by operation having sum(montant) <> 0',
  );
  for (const r of ops.rows) anomalies.push({ type: 'operation_desequilibree', ...r });
  return anomalies;
}
