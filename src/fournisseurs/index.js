// ============================================================================
// LES FOURNISSEURS — une seule interface, PaymentProvider :
//
//   nom, disponible, raison, devise
//   initier({ reference, montant: BigInt, telephone: '6XXXXXXXX', description })
//     → { refFournisseur }
//   statut(refFournisseur, reference)
//     → { etat: 'en_attente' | 'reussie' | 'echouee' | 'inconnu', montant: BigInt|null, devise, message }
//
// L'app choisit un OPÉRATEUR (MTN ou Orange) ; le serveur choisit le
// FOURNISSEUR qui le sert. MTN passe en direct dès que ses identifiants sont
// réglés, sinon par Fapshi. Orange passe par Fapshi : l'API marchande
// d'Orange Money Cameroun n'est pas publique (voir docs/API-FOURNISSEURS.md),
// et on n'invente pas d'endpoint.
// ============================================================================

import { creerFapshi } from './fapshi.js';
import { creerMtn } from './mtn.js';

function orangeDirect() {
  return {
    nom: 'orange',
    disponible: false,
    raison: 'specification_marchande_orange_requise',
    devise: 'XAF',
    async initier() {
      throw new Error('orange direct non disponible');
    },
    async statut() {
      return { etat: 'inconnu', message: 'orange direct non disponible' };
    },
  };
}

export function creerFournisseurs(config, options = {}) {
  const tous = {
    mtn: creerMtn(config.fournisseurs.mtn, { adressePublique: config.adressePublique, fetch: options.fetch }),
    fapshi: creerFapshi(config.fournisseurs.fapshi, { fetch: options.fetch }),
    orange: orangeDirect(),
  };

  function pour(operateur) {
    if (operateur === 'mtn') return tous.mtn.disponible ? tous.mtn : tous.fapshi.disponible ? tous.fapshi : null;
    if (operateur === 'orange') return tous.orange.disponible ? tous.orange : tous.fapshi.disponible ? tous.fapshi : null;
    return null;
  }

  return { tous, pour, par: (nom) => tous[nom] ?? null };
}
