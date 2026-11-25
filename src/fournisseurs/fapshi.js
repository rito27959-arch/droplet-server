// ============================================================================
// FAPSHI — agrégateur camerounais (MTN et Orange), utilisé par le Worker de
// licences depuis le départ. Il couvre Orange tant que l'API marchande
// d'Orange Money Cameroun n'est pas obtenue en direct.
//
//   POST {base}direct-pay          { amount, phone (9 chiffres), externalId, message } → { transId }
//   GET  {base}payment-status/{id} → { status, amount, externalId }
//        status : CREATED | PENDING → SUCCESSFUL | FAILED | EXPIRED
//
// En-têtes `apiuser` et `apikey`. Montant minimum : 100 XAF. Le numéro se
// donne en neuf chiffres locaux : le format international est refusé.
// (Détails relevés par le Worker de licences ; voir docs/API-FOURNISSEURS.md.)
// ============================================================================

export function creerFapshi(cfg, { fetch: f = fetch } = {}) {
  const disponible = Boolean(cfg.apiUser && cfg.apiKey);
  const entetes = () => ({ 'Content-Type': 'application/json', apiuser: cfg.apiUser, apikey: cfg.apiKey });

  return {
    nom: 'fapshi',
    disponible,
    raison: disponible ? null : 'identifiants_fapshi_absents',
    devise: 'XAF',
    minimum: 100n,

    async initier({ reference, montant, telephone, description }) {
      if (montant < 100n) throw new Error('fapshi : montant sous 100 XAF');
      const rep = await f(`${cfg.base}direct-pay`, {
        method: 'POST',
        headers: entetes(),
        body: JSON.stringify({ amount: Number(montant), phone: telephone, externalId: reference, message: description }),
      });
      const d = await rep.json().catch(() => ({}));
      if (!rep.ok || !d.transId) throw Object.assign(new Error(`fapshi direct-pay ${rep.status}`), { message: d.message });
      return { refFournisseur: String(d.transId) };
    },

    async statut(refFournisseur, reference) {
      const rep = await f(`${cfg.base}payment-status/${encodeURIComponent(refFournisseur)}`, { headers: entetes() });
      if (!rep.ok) return { etat: 'inconnu', message: `http ${rep.status}` };
      const d = await rep.json();
      // La transaction doit être LA NÔTRE : on relit l'identifiant que nous
      // avons donné à l'encaissement, pas ce que raconte le téléphone.
      if (reference && d.externalId !== reference) return { etat: 'inconnu', message: 'externalId différent' };
      const s = String(d.status || '').toUpperCase();
      const etat = s === 'SUCCESSFUL' ? 'reussie' : s === 'FAILED' || s === 'EXPIRED' ? 'echouee' : 'en_attente';
      const m = Number(d.amount);
      return { etat, montant: Number.isSafeInteger(m) ? BigInt(m) : null, devise: 'XAF', message: s };
    },
  };
}
