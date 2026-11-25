// ============================================================================
// MTN MOBILE MONEY — API Collections (RequestToPay), en direct.
// ----------------------------------------------------------------------------
// D'après la documentation officielle (sources dans docs/API-FOURNISSEURS.md) :
//
//   POST {base}/collection/token/              Basic(apiUser:apiKey) → access_token
//   POST {base}/collection/v1_0/requesttopay   202 Accepted
//        X-Reference-Id (UUID v4), X-Target-Environment, X-Callback-Url (facultatif)
//        { amount, currency, externalId, payer:{partyIdType, partyId}, payerMessage, payeeNote }
//   GET  {base}/collection/v1_0/requesttopay/{X-Reference-Id}
//        status : PENDING → SUCCESSFUL | FAILED
//
// Toutes les requêtes portent Ocp-Apim-Subscription-Key.
//
// ⚠️ Le rappel de MTN n'est envoyé qu'une fois, sans nouvel essai. On ne s'y
// fie donc jamais : il ne sert qu'à déclencher une relecture du statut, et la
// réconciliation relit de toute façon les demandes en attente.
//
// ⚠️ Le bac à sable n'accepte que l'euro (EUR). En production, la devise et
// l'environnement cible (X-Target-Environment) sont donnés par MTN à
// l'ouverture du compte marchand.
// ============================================================================

export function creerMtn(cfg, { adressePublique = '', fetch: f = fetch } = {}) {
  const disponible = Boolean(cfg.cleAbonnement && cfg.apiUser && cfg.apiKey);
  let jeton = null;
  let expireA = 0;

  async function token() {
    if (jeton && Date.now() < expireA - 60_000) return jeton;
    const rep = await f(`${cfg.base}/collection/token/`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.apiUser}:${cfg.apiKey}`).toString('base64')}`,
        'Ocp-Apim-Subscription-Key': cfg.cleAbonnement,
      },
    });
    if (!rep.ok) throw new Error(`mtn token ${rep.status}`);
    const d = await rep.json();
    if (!d.access_token) throw new Error('mtn token absent');
    jeton = d.access_token;
    expireA = Date.now() + Number(d.expires_in || 3600) * 1000;
    return jeton;
  }

  return {
    nom: 'mtn',
    disponible,
    raison: disponible ? null : 'identifiants_mtn_absents',
    devise: cfg.devise,

    async initier({ reference, montant, telephone, description }) {
      const entetes = {
        Authorization: `Bearer ${await token()}`,
        'X-Reference-Id': reference,
        'X-Target-Environment': cfg.environnement,
        'Ocp-Apim-Subscription-Key': cfg.cleAbonnement,
        'Content-Type': 'application/json',
      };
      if (adressePublique) entetes['X-Callback-Url'] = `${adressePublique}/v1/rappels/mtn/${reference}`;
      const rep = await f(`${cfg.base}/collection/v1_0/requesttopay`, {
        method: 'POST',
        headers: entetes,
        body: JSON.stringify({
          amount: montant.toString(),
          currency: cfg.devise,
          externalId: reference,
          payer: { partyIdType: 'MSISDN', partyId: `237${telephone}` },
          payerMessage: description,
          payeeNote: description,
        }),
      });
      if (rep.status !== 202) {
        const d = await rep.json().catch(() => ({}));
        throw Object.assign(new Error(`mtn requesttopay ${rep.status}`), { codeFournisseur: d.code, message: d.message });
      }
      return { refFournisseur: reference };
    },

    async statut(refFournisseur) {
      const rep = await f(`${cfg.base}/collection/v1_0/requesttopay/${encodeURIComponent(refFournisseur)}`, {
        headers: {
          Authorization: `Bearer ${await token()}`,
          'X-Target-Environment': cfg.environnement,
          'Ocp-Apim-Subscription-Key': cfg.cleAbonnement,
        },
      });
      if (!rep.ok) return { etat: 'inconnu', message: `http ${rep.status}` };
      const d = await rep.json();
      const s = String(d.status || '').toUpperCase();
      const etat = s === 'SUCCESSFUL' ? 'reussie' : s === 'FAILED' ? 'echouee' : 'en_attente';
      return {
        etat,
        montant: /^\d+$/.test(String(d.amount ?? '')) ? BigInt(d.amount) : null,
        devise: d.currency ?? null,
        message: d.reason ? String(d.reason.code ?? d.reason) : null,
      };
    },
  };
}
