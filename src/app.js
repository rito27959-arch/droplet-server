// ============================================================================
// L'API HTTP DE DROPLET PAY.
// ----------------------------------------------------------------------------
//   GET  /sante
//   GET  /v1/catalogue                      public
//   GET  /v1/operateurs                     public : MTN / Orange disponibles ?
//   POST /v1/appareils                      signé (X-Droplet-Cle) + attestation Droplet ID
//   GET  /v1/moi                            signé : compte, solde, droits actifs
//   GET  /v1/historique?avant=&limite=      signé
//   POST /v1/recharges                      signé + Idempotency-Key
//   GET  /v1/recharges/:id                  signé : relit l'opérateur si en attente
//   POST /v1/achats                         signé + Idempotency-Key
//   POST|PUT /v1/rappels/mtn/:id            rappel MTN (corps ignoré)
//   POST /v1/rappels/fapshi                 rappel Fapshi (seul transId est lu)
//
// Le chemin signé est le chemin complet, requête comprise (`/v1/historique?avant=12`).
// Les entiers d'argent voyagent en CHAÎNES dans le JSON : un nombre JSON
// passe par un flottant dans la plupart des langages.
// ============================================================================

import { createHash } from 'node:crypto';
import http from 'node:http';

import { acheter, droitsActifs } from './achats.js';
import { catalogueExpose } from './catalogue.js';
import { enTransaction } from './db.js';
import { verifierAttestation } from './jetons.js';
import { journaliser } from './journal.js';
import { actualiserRecharge, creerRecharge, exposerRecharge } from './recharges.js';
import { assurerCompteRegistre, codePortefeuille, ErreurMetier, historique, solde } from './registre.js';
import { verifierRequete } from './signature.js';

const TAILLE_MAX = 16 * 1024;

function json(res, statut, corps) {
  const texte = JSON.stringify(corps, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(statut, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(texte);
}

function lireCorps(req) {
  return new Promise((ok, ko) => {
    let n = 0;
    const morceaux = [];
    req.on('data', (m) => {
      n += m.length;
      if (n > TAILLE_MAX) {
        ko(new ErreurMetier('corps_trop_grand', 413));
        req.destroy();
      } else morceaux.push(m);
    });
    req.on('end', () => ok(Buffer.concat(morceaux).toString('utf8')));
    req.on('error', ko);
  });
}

function analyser(texte) {
  if (!texte) return {};
  try {
    const v = JSON.parse(texte);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  throw new ErreurMetier('json_invalide');
}

export function creerApp({ pool, config, fournisseurs, clePriveeRecus }) {
  async function signe(req, chemin, corps) {
    return enTransaction(pool, (c) => verifierRequete(c, {
      methode: req.method, chemin, entetes: req.headers, corps, fenetre: config.fenetreSignature,
    }));
  }

  /** Idempotence : la même clé rend la même réponse, sans refaire l'action. */
  async function idempotent(req, compte, chemin, corps, action) {
    const cle = req.headers['idempotency-key'];
    if (!cle || !/^[A-Za-z0-9_-]{8,100}$/.test(cle)) throw new ErreurMetier('cle_idempotence_requise');
    const empreinte = createHash('sha256').update(`${req.method}\n${chemin}\n${corps}`).digest('hex');
    const ins = await pool.query(
      'insert into idempotence (compte, cle, empreinte) values ($1, $2, $3) on conflict do nothing',
      [compte, cle, empreinte],
    );
    if (!ins.rowCount) {
      const ex = (await pool.query('select empreinte, statut, reponse from idempotence where compte = $1 and cle = $2', [compte, cle])).rows[0];
      if (ex.empreinte !== empreinte) throw new ErreurMetier('cle_idempotence_reutilisee', 422);
      if (ex.statut === null) throw new ErreurMetier('requete_en_cours', 409);
      return { statut: ex.statut, corps: ex.reponse };
    }
    try {
      const corpsRep = await action(cle);
      const propre = JSON.parse(JSON.stringify(corpsRep, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
      await pool.query('update idempotence set statut = 200, reponse = $3 where compte = $1 and cle = $2', [compte, cle, propre]);
      return { statut: 200, corps: propre };
    } catch (e) {
      // Une erreur ne se mémorise pas : après une recharge, le même achat
      // refusé pour solde insuffisant doit pouvoir être retenté.
      await pool.query('delete from idempotence where compte = $1 and cle = $2', [compte, cle]);
      throw e;
    }
  }

  async function router(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const chemin = `${url.pathname}${url.search}`;
    const corps = req.method === 'GET' ? '' : await lireCorps(req);
    let m;

    if (req.method === 'GET' && p === '/sante') return json(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/v1/catalogue') return json(res, 200, catalogueExpose());
    if (req.method === 'GET' && p === '/v1/operateurs') {
      const etat = (op) => {
        const f = fournisseurs.pour(op);
        return f ? { disponible: true, via: f.nom, sandbox: f.nom === 'mtn' ? config.fournisseurs.mtn.environnement === 'sandbox' : f.nom === 'fapshi' ? config.fournisseurs.fapshi.base.includes('sandbox') : true } : { disponible: false };
      };
      return json(res, 200, { mtn: etat('mtn'), orange: etat('orange') });
    }

    // ── Rappels des opérateurs : un simple « va relire » ──
    if ((req.method === 'POST' || req.method === 'PUT') && (m = p.match(/^\/v1\/rappels\/mtn\/([0-9a-f-]{36})$/))) {
      await actualiserRecharge(pool, fournisseurs, m[1], config).catch(() => {});
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/v1/rappels/fapshi') {
      const transId = String(analyser(corps).transId ?? '');
      const r = await pool.query("select id from recharges where fournisseur = 'fapshi' and ref_fournisseur = $1", [transId]);
      if (r.rowCount) await actualiserRecharge(pool, fournisseurs, r.rows[0].id, config).catch(() => {});
      return json(res, 200, { ok: true });
    }

    // ── Enregistrement d'un appareil ──
    if (req.method === 'POST' && p === '/v1/appareils') {
      const qui = await signe(req, chemin, corps);
      if (!qui.cleBrute) throw new ErreurMetier('cle_requise', 400);
      const a = verifierAttestation(analyser(corps).attestation, config.dropletId, qui.cleBrute);
      return json(res, 200, await enTransaction(pool, async (c) => {
        await c.query('insert into comptes (id) values ($1) on conflict do nothing', [a.compte]);
        const ex = await c.query('select compte, cle_pub, revoque_le from appareils where id = $1', [a.appareil]);
        if (ex.rowCount) {
          const e = ex.rows[0];
          if (e.compte !== a.compte || e.cle_pub !== a.cle || e.revoque_le) throw new ErreurMetier('appareil_conflit', 409);
        } else {
          await c.query('insert into appareils (id, compte, cle_pub) values ($1, $2, $3)', [a.appareil, a.compte, a.cle]);
          await journaliser(c, a.compte, 'appareil.enregistre', { appareil: a.appareil });
        }
        await assurerCompteRegistre(c, codePortefeuille(a.compte), 'portefeuille', a.compte);
        return { compte: a.compte, appareil: a.appareil };
      }));
    }

    // ── Tout le reste exige un appareil enregistré ──
    if (!p.startsWith('/v1/')) throw new ErreurMetier('introuvable', 404);
    const qui = await signe(req, chemin, corps);
    if (!qui.compte) throw new ErreurMetier('appareil_non_enregistre', 401);
    const compte = qui.compte;

    if (req.method === 'GET' && p === '/v1/moi') {
      const c = await pool.connect();
      try {
        return json(res, 200, { compte, solde: await solde(c, compte), droits: await droitsActifs(c, compte, clePriveeRecus) });
      } finally {
        c.release();
      }
    }

    if (req.method === 'GET' && p === '/v1/historique') {
      const avant = url.searchParams.get('avant');
      const lignes = await historique(pool, compte, {
        avant: avant && /^\d+$/.test(avant) ? avant : null,
        limite: Number(url.searchParams.get('limite') || 30),
      });
      return json(res, 200, { lignes });
    }

    if (req.method === 'POST' && p === '/v1/recharges') {
      const b = analyser(corps);
      const r = await idempotent(req, compte, chemin, corps, () =>
        creerRecharge(pool, fournisseurs, { compte, palier: b.palier, operateur: b.operateur, telephone: b.telephone }));
      return json(res, r.statut, r.corps);
    }

    if (req.method === 'GET' && (m = p.match(/^\/v1\/recharges\/([0-9a-f-]{36})$/))) {
      const r = await pool.query('select * from recharges where id = $1 and compte = $2', [m[1], compte]);
      if (!r.rowCount) throw new ErreurMetier('recharge_inconnue', 404);
      const fini = r.rows[0].etat === 'reussie' || r.rows[0].etat === 'echouee';
      return json(res, 200, fini ? exposerRecharge(r.rows[0]) : await actualiserRecharge(pool, fournisseurs, m[1], config));
    }

    if (req.method === 'POST' && p === '/v1/achats') {
      const b = analyser(corps);
      const r = await idempotent(req, compte, chemin, corps, (cle) =>
        enTransaction(pool, async (c) => {
          const a = await acheter(c, { compte, produit: b.produit, destinataire: b.destinataire ?? null, cle, clePrivee: clePriveeRecus });
          return { ...a, solde: await solde(c, compte) };
        }));
      return json(res, r.statut, r.corps);
    }

    throw new ErreurMetier('introuvable', 404);
  }

  return http.createServer((req, res) => {
    router(req, res).catch((e) => {
      if (e instanceof ErreurMetier) return json(res, e.statut, { erreur: e.code });
      console.error('[pay]', e);
      json(res, 500, { erreur: 'interne' });
    });
  });
}
