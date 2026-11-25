// ============================================================================
// LE JOURNAL D'AUDIT — chaque événement d'argent, chaîné.
// ----------------------------------------------------------------------------
// Chaque ligne porte le hash de la précédente : supprimer ou réécrire une
// ligne au milieu casse toute la suite, et `verifierJournal` le voit. La base
// refuse déjà UPDATE et DELETE ; la chaîne protège aussi contre quelqu'un qui
// aurait les droits de désactiver ce déclencheur.
//
// On n'y écrit JAMAIS un numéro de téléphone complet ni un secret.
// ============================================================================

import { createHash } from 'node:crypto';

const GENESE = '0'.repeat(64);

// jsonb réordonne les clés : on hache une forme canonique (clés triées),
// identique à l'écriture et à la relecture.
function canonique(v) {
  if (Array.isArray(v)) return `[${v.map(canonique).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonique(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(typeof v === 'bigint' ? v.toString() : v);
}

function empreinte(prec, acteur, action, details) {
  return createHash('sha256').update(`${prec}\n${acteur}\n${action}\n${canonique(details)}`).digest('hex');
}

export async function journaliser(c, acteur, action, brut = {}) {
  const details = JSON.parse(JSON.stringify(brut, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  // Un seul écrivain à la fois dans la chaîne : le verrou est relâché à la
  // fin de la transaction.
  await c.query('select pg_advisory_xact_lock(727275)');
  const r = await c.query('select hash from journal order by id desc limit 1');
  const prec = r.rowCount ? r.rows[0].hash : GENESE;
  const h = empreinte(prec, acteur, action, details);
  await c.query('insert into journal (acteur, action, details, hash_prec, hash) values ($1, $2, $3, $4, $5)', [acteur, action, details, prec, h]);
}

export async function verifierJournal(c) {
  const r = await c.query('select id, acteur, action, details, hash_prec, hash from journal order by id');
  let prec = GENESE;
  for (const l of r.rows) {
    if (l.hash_prec !== prec || empreinte(prec, l.acteur, l.action, l.details) !== l.hash) return { ok: false, ligne: l.id };
    prec = l.hash;
  }
  return { ok: true, lignes: r.rowCount };
}
