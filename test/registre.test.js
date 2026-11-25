import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { enTransaction } from '../src/db.js';
import { journaliser, verifierJournal } from '../src/journal.js';
import { codePortefeuille, passerOperation, solde, verifierRegistre } from '../src/registre.js';
import { baseNeuve } from './outils.js';

let pool;
before(async () => {
  pool = await baseNeuve();
  await pool.query("insert into comptes (id) values ('ana'), ('ben')");
});
after(() => pool.end());

const recharge = (ref, compte, n) => ({
  nature: 'recharge',
  reference: ref,
  lignes: [
    { code: 'compensation:test', nature: 'compensation', montant: -BigInt(n) },
    { code: codePortefeuille(compte), nature: 'portefeuille', compte, montant: BigInt(n) },
  ],
});

test('une opération déséquilibrée est refusée, avant même la base', async () => {
  await assert.rejects(
    enTransaction(pool, (c) => passerOperation(c, { nature: 'correction', reference: 'x1', lignes: [
      { code: codePortefeuille('ana'), nature: 'portefeuille', compte: 'ana', montant: 5n },
    ] })),
    /déséquilibrée/,
  );
});

test('la base refuse elle-même une opération déséquilibrée écrite à la main', async () => {
  await assert.rejects(enTransaction(pool, async (c) => {
    await c.query("insert into operations (id, nature, reference) values ('00000000-0000-4000-8000-000000000001', 'correction', 'manuelle')");
    const cr = await c.query("insert into comptes_registre (code, nature) values ('compensation:main', 'compensation') returning id");
    await c.query("insert into ecritures (operation, compte_registre, montant) values ('00000000-0000-4000-8000-000000000001', $1, 7)", [cr.rows[0].id]);
  }), /desequilibree/);
});

test('crédit puis solde, et une même référence ne crédite qu’une fois', async () => {
  const a = await enTransaction(pool, (c) => passerOperation(c, recharge('recharge:r1', 'ana', 100)));
  const b = await enTransaction(pool, (c) => passerOperation(c, recharge('recharge:r1', 'ana', 100)));
  assert.equal(a.deja, false);
  assert.equal(b.deja, true);
  assert.equal(b.id, a.id);
  assert.equal(await solde(pool, 'ana'), 100n);
});

test('le découvert est refusé par la base', async () => {
  await assert.rejects(
    enTransaction(pool, (c) => passerOperation(c, { nature: 'achat', reference: 'achat:trop', lignes: [
      { code: codePortefeuille('ana'), nature: 'portefeuille', compte: 'ana', montant: -101n },
      { code: 'produits', nature: 'produits', montant: 101n },
    ] })),
    (e) => e.code === 'solde_insuffisant',
  );
  assert.equal(await solde(pool, 'ana'), 100n);
});

test('les écritures ne se modifient ni ne s’effacent', async () => {
  await assert.rejects(pool.query('update ecritures set montant = 1'), /ajout seul/);
  await assert.rejects(pool.query('delete from ecritures'), /ajout seul/);
});

test('cent débits concurrents de 1 sur un solde de 30 : exactement 30 passent', async () => {
  await enTransaction(pool, (c) => passerOperation(c, recharge('recharge:r2', 'ben', 30)));
  const essais = await Promise.allSettled(Array.from({ length: 100 }, (_, i) =>
    enTransaction(pool, (c) => passerOperation(c, { nature: 'achat', reference: `achat:ben:${i}`, lignes: [
      { code: codePortefeuille('ben'), nature: 'portefeuille', compte: 'ben', montant: -1n },
      { code: 'produits', nature: 'produits', montant: 1n },
    ] }))));
  assert.equal(essais.filter((e) => e.status === 'fulfilled').length, 30);
  assert.ok(essais.filter((e) => e.status === 'rejected').every((e) => e.reason.code === 'solde_insuffisant'));
  assert.equal(await solde(pool, 'ben'), 0n);
});

test('le journal est chaîné et vérifiable', async () => {
  await enTransaction(pool, (c) => journaliser(c, 'ana', 'test', { b: 2, a: 1, n: 5n }));
  await enTransaction(pool, (c) => journaliser(c, 'ben', 'test', { x: 'y' }));
  const v = await verifierJournal(pool);
  assert.equal(v.ok, true);
  assert.ok(v.lignes >= 2);
  await assert.rejects(pool.query("update journal set acteur = 'pirate'"), /ajout seul/);
});

test('le registre entier est cohérent', async () => {
  assert.deepEqual(await verifierRegistre(pool), []);
});
