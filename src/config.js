// ============================================================================
// LA CONFIGURATION — tout vient de l'environnement, rien n'est dans le dépôt.
// ----------------------------------------------------------------------------
// Les identifiants des opérateurs vivent dans les variables du service
// (Railway), jamais dans le code ni dans l'app Flutter.
//
// ⚠️ PAR DÉFAUT, TOUT EST EN BAC À SABLE. Un service démarré sans réglage ne
// peut pas encaisser d'argent réel : il faut écrire `production` en toutes
// lettres, fournisseur par fournisseur.
// ============================================================================

const env = process.env;

function lire(nom, defaut) {
  const v = env[nom];
  return v === undefined || v === '' ? defaut : v;
}

export function chargerConfig(surcharges = {}) {
  const c = {
    port: Number(lire('PORT', 8080)),
    baseDeDonnees: lire('DATABASE_URL', 'postgres://pay@localhost:54329/pay'),

    // L'adresse publique du service, pour les rappels des opérateurs.
    adressePublique: lire('ADRESSE_PUBLIQUE', ''),

    // Fenêtre de validité d'une requête signée, en secondes.
    fenetreSignature: 300,

    // Droplet ID : qui signe les attestations « cet appareil appartient à ce
    // compte ». Clé publique Ed25519 brute en base64url.
    dropletId: {
      emetteur: lire('DROPLET_ID_EMETTEUR', 'https://id.dropletmesh.app'),
      clePublique: lire('DROPLET_ID_CLE_ATTESTATION', ''),
    },

    // La clé qui signe les reçus de droits, pour que l'app les vérifie hors
    // ligne, comme les licences. Graine Ed25519 brute, base64url.
    cleRecus: lire('PAY_CLE_RECUS', ''),

    fournisseurs: {
      mtn: {
        environnement: lire('MTN_ENVIRONNEMENT', 'sandbox'),
        base: lire('MTN_BASE', 'https://sandbox.momodeveloper.mtn.com'),
        cleAbonnement: lire('MTN_CLE_ABONNEMENT_COLLECTION', ''),
        apiUser: lire('MTN_API_USER', ''),
        apiKey: lire('MTN_API_KEY', ''),
        // Le bac à sable MTN n'accepte que l'euro ; la production, la devise
        // du pays (XAF au Cameroun).
        devise: lire('MTN_DEVISE', lire('MTN_ENVIRONNEMENT', 'sandbox') === 'sandbox' ? 'EUR' : 'XAF'),
      },
      fapshi: {
        base: lire('FAPSHI_BASE', 'https://sandbox.fapshi.com/'),
        apiUser: lire('FAPSHI_USER', ''),
        apiKey: lire('FAPSHI_KEY', ''),
      },
      orange: {
        // Vide tant que la spécification marchande d'Orange Money Cameroun
        // n'a pas été obtenue : voir docs/API-FOURNISSEURS.md.
        base: lire('ORANGE_BASE', ''),
      },
    },

    // Combien de temps une recharge reste « en attente » avant d'être
    // signalée pour vérification humaine. Elle n'est JAMAIS déclarée échouée
    // sur un simple délai : l'argent peut être parti.
    delaiVerificationMinutes: Number(lire('DELAI_VERIFICATION_MINUTES', 60)),
  };
  return { ...c, ...surcharges };
}
