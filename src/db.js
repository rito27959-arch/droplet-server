import { readFile } from 'node:fs/promises';
import pg from 'pg';

import { semerCatalogue } from './catalogue.js';

// bigint (int8) → BigInt côté JS : un solde ne passe jamais par un Number.
pg.types.setTypeParser(20, (v) => BigInt(v));

export function ouvrir(url) {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function migrer(pool) {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  // Un verrou consultatif : deux instances qui démarrent ensemble ne
  // migrent pas en même temps.
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(727274)');
    await c.query(sql);
    await semerCatalogue(c);
  } finally {
    await c.query('select pg_advisory_unlock(727274)').catch(() => {});
    c.release();
  }
}

/**
 * Exécute `travail` dans une transaction. Rejoue jusqu'à 3 fois sur un
 * conflit de sérialisation ou un interblocage — jamais sur une autre erreur.
 */
export async function enTransaction(pool, travail) {
  for (let essai = 1; ; essai++) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      const r = await travail(c);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      if ((e.code === '40001' || e.code === '40P01') && essai < 3) continue;
      throw e;
    } finally {
      c.release();
    }
  }
}
