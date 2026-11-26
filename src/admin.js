// ============================================================================
// L'ADMINISTRATION — /admin/v1/*, derrière un jeton.
// ----------------------------------------------------------------------------
// Le jeton n'est jamais stocké : seule son empreinte SHA-256 est dans
// l'environnement (ADMIN_JETON_SHA256), comparée en temps constant. Sans
// cette variable, toute l'administration répond 404.
//
// Chaque écriture passe par le journal chaîné, avec l'acteur « admin ».
// L'administration ne peut PAS créditer un portefeuille à la main : les DC
// n'entrent que par une recharge confirmée par un opérateur. Elle peut
// rembourser un achat (écriture inverse) et régler le catalogue.
// ============================================================================

import { createHash, timingSafeEqual } from 'node:crypto';

import { rembourser } from './achats.js';
import { enTransaction } from './db.js';
import { journaliser, verifierJournal } from './journal.js';
import { ErreurMetier, verifierRegistre } from './registre.js';

const CLE = /^[a-z0-9_]{2,48}$/;
const GENRES = ['cadre', 'style_nom', 'badge', 'theme', 'stickers', 'pack', 'pro', 'premium', 'collection'];
const STATUTS = ['brouillon', 'en_revue', 'publie', 'refuse', 'retire'];

export function jetonValide(entete, empreinteAttendue) {
  if (!empreinteAttendue || !/^[0-9a-f]{64}$/.test(empreinteAttendue)) return false;
  const m = /^Bearer (.{32,200})$/.exec(String(entete ?? ''));
  if (!m) return false;
  const recue = createHash('sha256').update(m[1]).digest();
  return timingSafeEqual(recue, Buffer.from(empreinteAttendue, 'hex'));
}

const entier = (v, nom, min = 0) => {
  const s = String(v ?? '');
  if (!/^\d{1,12}$/.test(s) || BigInt(s) < BigInt(min)) throw new ErreurMetier(`${nom}_invalide`);
  return BigInt(s);
};

function verifierDonnees(d) {
  if (d === undefined) return undefined;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new ErreurMetier('donnees_invalides');
  if (JSON.stringify(d).length > 8000) throw new ErreurMetier('donnees_trop_grandes');
  if (!d.nom?.fr) throw new ErreurMetier('nom_fr_requis');
  return d;
}

/** Rend `{ statut, corps }`, ou `null` si la route n'existe pas. */
export async function routeAdmin(pool, { methode, p, url, corps: b }) {
  let m;
  const q = (sql, v) => pool.query(sql, v);
  const ecrire = (action, details, travail) => enTransaction(pool, async (c) => {
    const r = await travail(c);
    await journaliser(c, 'admin', action, details);
    return r;
  });

  if (methode === 'GET' && p === '/admin/v1/tableau') {
    const [ventes, recharges, attente, top, suspects] = await Promise.all([
      q(`select count(*)::int as n, coalesce(sum((details->>'prix')::bigint), 0) as dc from operations o
          where nature in ('achat', 'cadeau') and cree_le > now() - interval '30 days'
            and not exists (select 1 from operations r where r.reference = 'remboursement:' || o.id)`),
      q(`select count(*)::int as n, coalesce(sum(montant_xaf), 0) as xaf from recharges where etat = 'reussie' and cree_le > now() - interval '30 days'`),
      q(`select count(*)::int as n from recharges where etat = 'a_verifier'`),
      q(`select details->>'produit' as produit, count(*)::int as n, sum((details->>'prix')::bigint) as dc from operations
          where nature in ('achat', 'cadeau') and cree_le > now() - interval '30 days' group by 1 order by n desc limit 10`),
      suspectsQ(pool),
    ]);
    return { statut: 200, corps: {
      ventes30j: { achats: ventes.rows[0].n, dc: ventes.rows[0].dc },
      recharges30j: { nombre: recharges.rows[0].n, xaf: recharges.rows[0].xaf },
      aVerifier: attente.rows[0].n,
      top: top.rows,
      suspects: suspects.length,
    } };
  }

  // ── Produits ──
  if (methode === 'GET' && p === '/admin/v1/produits') {
    const r = await q(`select p.*, (select count(*)::int from droits d where d.produit = p.cle and d.revoque_le is null) as possesseurs
                         from produits p order by categorie, ordre, cle`);
    return { statut: 200, corps: { produits: r.rows } };
  }
  if (methode === 'POST' && p === '/admin/v1/produits') {
    if (!CLE.test(b.cle ?? '')) throw new ErreurMetier('cle_invalide');
    if (!GENRES.includes(b.genre)) throw new ErreurMetier('genre_inconnu');
    const type = b.type ?? 'definitif';
    const prix = entier(b.prix, 'prix');
    const jours = type === 'abonnement' ? Number(entier(b.jours, 'jours', 1)) : null;
    const statut = b.statut ?? 'brouillon';
    if (!STATUTS.includes(statut)) throw new ErreurMetier('statut_inconnu');
    const donnees = verifierDonnees(b.donnees);
    const r = await ecrire('produit.cree', { cle: b.cle, prix }, async (c) => {
      const ins = await c.query(
        `insert into produits (cle, categorie, genre, type, prix, jours, collection, createur, statut, ordre, donnees)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
        [b.cle, b.categorie, b.genre, type, prix, jours, b.collection ?? null, b.createur ?? null, statut, Number(b.ordre ?? 0), donnees],
      );
      await c.query("insert into prix_historique (produit, prix, par) values ($1, $2, 'admin')", [b.cle, prix]);
      if (type === 'collection') {
        for (const a of b.articles ?? []) await c.query('insert into collection_articles (produit_collection, produit) values ($1, $2)', [b.cle, a]);
      }
      return ins.rows[0];
    }).catch((e) => {
      if (e.code === '23505') throw new ErreurMetier('cle_existante', 409);
      if (e.code === '23503') throw new ErreurMetier('reference_inconnue', 422);
      throw e;
    });
    return { statut: 201, corps: r };
  }
  if (methode === 'PATCH' && (m = p.match(/^\/admin\/v1\/produits\/([a-z0-9_]+)$/))) {
    const cle = m[1];
    const champs = [];
    const valeurs = [cle];
    const poser = (col, v) => { valeurs.push(v); champs.push(`${col} = $${valeurs.length}`); };
    let prix;
    if (b.prix !== undefined) poser('prix', (prix = entier(b.prix, 'prix')));
    if (b.statut !== undefined) {
      if (!STATUTS.includes(b.statut)) throw new ErreurMetier('statut_inconnu');
      poser('statut', b.statut);
    }
    if (b.ordre !== undefined) poser('ordre', Number(entier(b.ordre, 'ordre')));
    if (b.nouveau !== undefined) poser('nouveau', Boolean(b.nouveau));
    if (b.misEnAvant !== undefined) poser('mis_en_avant', Boolean(b.misEnAvant));
    if (b.collection !== undefined) poser('collection', b.collection || null);
    if (b.donnees !== undefined) poser('donnees', verifierDonnees(b.donnees));
    if (!champs.length) throw new ErreurMetier('rien_a_changer');
    const r = await ecrire('produit.modifie', { cle, ...b, donnees: b.donnees ? '(modifiées)' : undefined }, async (c) => {
      const u = await c.query(`update produits set ${champs.join(', ')}, maj_le = now() where cle = $1 returning *`, valeurs);
      if (!u.rowCount) throw new ErreurMetier('produit_inconnu', 404);
      if (prix !== undefined) await c.query("insert into prix_historique (produit, prix, par) values ($1, $2, 'admin')", [cle, prix]);
      return u.rows[0];
    });
    return { statut: 200, corps: r };
  }
  // Le test de prix : les ventes par période de prix, pour comparer.
  if (methode === 'GET' && (m = p.match(/^\/admin\/v1\/produits\/([a-z0-9_]+)\/prix$/))) {
    const r = await q(
      `with h as (select prix, depuis, lead(depuis) over (order by depuis) as jusqua from prix_historique where produit = $1)
       select h.prix, h.depuis, h.jusqua,
              extract(epoch from (coalesce(h.jusqua, now()) - h.depuis)) / 86400 as jours,
              (select count(*)::int from operations o where o.details->>'produit' = $1 and o.nature in ('achat', 'cadeau')
                 and o.cree_le >= h.depuis and (h.jusqua is null or o.cree_le < h.jusqua)) as ventes
         from h order by h.depuis`,
      [m[1]],
    );
    return { statut: 200, corps: { periodes: r.rows } };
  }

  // ── Packs de crédits ──
  if (methode === 'GET' && p === '/admin/v1/paliers') {
    return { statut: 200, corps: { paliers: (await q('select * from paliers order by ordre')).rows } };
  }
  if (methode === 'PATCH' && (m = p.match(/^\/admin\/v1\/paliers\/([a-z0-9_]+)$/))) {
    const r = await ecrire('palier.modifie', { cle: m[1], ...b }, async (c) => {
      const u = await c.query(
        `update paliers set credits = coalesce($2, credits), montant_xaf = coalesce($3, montant_xaf), actif = coalesce($4, actif)
          where cle = $1 returning *`,
        [m[1], b.credits !== undefined ? entier(b.credits, 'credits', 1) : null, b.montantXaf !== undefined ? entier(b.montantXaf, 'montant', 1) : null, b.actif ?? null],
      );
      if (!u.rowCount) throw new ErreurMetier('palier_inconnu', 404);
      return u.rows[0];
    });
    return { statut: 200, corps: r };
  }

  // ── Collections ──
  if (methode === 'POST' && p === '/admin/v1/collections') {
    if (!CLE.test(b.cle ?? '')) throw new ErreurMetier('cle_invalide');
    const r = await ecrire('collection.creee', { cle: b.cle }, (c) =>
      c.query('insert into collections (cle, ordre) values ($1, $2) returning *', [b.cle, Number(b.ordre ?? 0)]).then((x) => x.rows[0]));
    return { statut: 201, corps: r };
  }

  // ── Transactions, recharges, remboursements ──
  if (methode === 'GET' && p === '/admin/v1/transactions') {
    const avant = url.searchParams.get('avant');
    const r = await q(
      `select o.id, o.nature, o.reference, o.cree_le, o.details,
              (select json_agg(json_build_object('compte', cr.code, 'montant', e.montant::text)) from ecritures e
                 join comptes_registre cr on cr.id = e.compte_registre where e.operation = o.id) as lignes
         from operations o where ($1::timestamptz is null or o.cree_le < $1) order by o.cree_le desc limit 100`,
      [avant || null],
    );
    return { statut: 200, corps: { operations: r.rows } };
  }
  if (methode === 'GET' && p === '/admin/v1/recharges') {
    const etat = url.searchParams.get('etat');
    const r = await q(
      `select * from recharges where ($1::text is null or etat = $1) order by cree_le desc limit 100`,
      [etat || null],
    );
    return { statut: 200, corps: { recharges: r.rows } };
  }
  if (methode === 'GET' && (m = p.match(/^\/admin\/v1\/recharges\/([0-9a-f-]{36})\/evenements$/))) {
    const r = await q('select * from evenements_paiement where recharge = $1 order by id', [m[1]]);
    return { statut: 200, corps: { evenements: r.rows } };
  }
  if (methode === 'POST' && p === '/admin/v1/remboursements') {
    if (!/^[0-9a-f-]{36}$/.test(b.operation ?? '')) throw new ErreurMetier('operation_invalide');
    if (!String(b.motif ?? '').trim()) throw new ErreurMetier('motif_requis');
    const r = await enTransaction(pool, (c) => rembourser(c, { operation: b.operation, motif: b.motif, acteur: 'admin' }));
    return { statut: 200, corps: r };
  }

  // ── Abonnements ──
  if (methode === 'GET' && p === '/admin/v1/abonnements') {
    const r = await q(`select d.*, p.genre from droits d join produits p on p.cle = d.produit
                        where p.type = 'abonnement' and d.revoque_le is null and d.fin > now() order by d.fin`);
    return { statut: 200, corps: { abonnements: r.rows } };
  }

  // ── Créateurs et modération ──
  if (methode === 'GET' && p === '/admin/v1/createurs') {
    const r = await q(`select cr.*, (select count(*)::int from produits p where p.createur = cr.id and p.statut = 'publie') as publies,
                              (select count(*)::int from operations o join produits p on p.cle = o.details->>'produit'
                                 where p.createur = cr.id and o.nature in ('achat', 'cadeau')) as ventes
                         from createurs cr order by cr.cree_le desc`);
    return { statut: 200, corps: { createurs: r.rows } };
  }
  if (methode === 'POST' && p === '/admin/v1/createurs') {
    if (!CLE.test(b.id ?? '') || !String(b.nomPublic ?? '').trim()) throw new ErreurMetier('createur_invalide');
    const r = await ecrire('createur.cree', { id: b.id }, (c) =>
      c.query('insert into createurs (id, compte, nom_public) values ($1, $2, $3) returning *', [b.id, b.compte ?? null, String(b.nomPublic).slice(0, 60)])
        .then((x) => x.rows[0]));
    return { statut: 201, corps: r };
  }
  if (methode === 'PATCH' && (m = p.match(/^\/admin\/v1\/createurs\/([a-z0-9_]+)$/))) {
    if (!['actif', 'suspendu'].includes(b.statut)) throw new ErreurMetier('statut_inconnu');
    const r = await ecrire('createur.statut', { id: m[1], statut: b.statut }, (c) =>
      c.query('update createurs set statut = $2 where id = $1 returning *', [m[1], b.statut]).then((x) => x.rows[0]));
    return { statut: 200, corps: r };
  }
  if (methode === 'GET' && p === '/admin/v1/moderation') {
    const r = await q("select * from produits where statut = 'en_revue' order by maj_le");
    return { statut: 200, corps: { aRevoir: r.rows } };
  }
  if (methode === 'POST' && (m = p.match(/^\/admin\/v1\/moderation\/([a-z0-9_]+)$/))) {
    if (!['publier', 'refuser'].includes(b.decision)) throw new ErreurMetier('decision_inconnue');
    if (b.decision === 'refuser' && !String(b.motif ?? '').trim()) throw new ErreurMetier('motif_requis');
    const r = await ecrire(`moderation.${b.decision}`, { cle: m[1], motif: b.motif }, async (c) => {
      const u = await c.query(
        `update produits set statut = $2, motif = $3, maj_le = now() where cle = $1 and statut = 'en_revue' returning *`,
        [m[1], b.decision === 'publier' ? 'publie' : 'refuse', b.decision === 'refuser' ? String(b.motif).slice(0, 300) : null],
      );
      if (!u.rowCount) throw new ErreurMetier('rien_a_moderer', 404);
      return u.rows[0];
    });
    return { statut: 200, corps: r };
  }

  // ── Activités suspectes et intégrité ──
  if (methode === 'GET' && p === '/admin/v1/suspects') return { statut: 200, corps: { signaux: await suspectsQ(pool) } };
  if (methode === 'GET' && p === '/admin/v1/integrite') {
    return { statut: 200, corps: { registre: await verifierRegistre(pool), journal: await verifierJournal(pool) } };
  }
  if (methode === 'GET' && p === '/admin/v1/journal') {
    const r = await q('select id, quand, acteur, action, details from journal order by id desc limit 200');
    return { statut: 200, corps: { lignes: r.rows } };
  }
  return null;
}

/**
 * Des signaux, pas des verdicts : un humain regarde avant toute décision.
 *   • beaucoup de recharges échouées en 24 h (numéros essayés au hasard ?) ;
 *   • beaucoup de recharges réussies en 24 h (revente ? compte partagé ?) ;
 *   • des recharges « à vérifier » depuis plus d'un jour ;
 *   • beaucoup de cadeaux vers un même compte en 24 h.
 */
async function suspectsQ(pool) {
  const r = await pool.query(`
    select 'recharges_echouees' as signal, compte, count(*)::int as n from recharges
      where etat = 'echouee' and cree_le > now() - interval '24 hours' group by compte having count(*) >= 5
    union all
    select 'recharges_nombreuses', compte, count(*)::int from recharges
      where etat = 'reussie' and cree_le > now() - interval '24 hours' group by compte having count(*) >= 10
    union all
    select 'a_verifier_ancienne', compte, count(*)::int from recharges
      where etat = 'a_verifier' and maj_le < now() - interval '24 hours' group by compte
    union all
    select 'cadeaux_recus_nombreux', details->>'destinataire', count(*)::int from operations
      where nature = 'cadeau' and cree_le > now() - interval '24 hours' group by 2 having count(*) >= 10`);
  return r.rows;
}
