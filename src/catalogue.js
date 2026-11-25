// ============================================================================
// LE CATALOGUE — ce qu'on achète avec des Gouttes, et comment on en achète.
// ----------------------------------------------------------------------------
// Une Goutte vaut 10 F CFA au palier de base. Les paliers plus gros donnent
// quelques Gouttes de plus, comme les paquets d'étoiles de Telegram.
//
// ⚠️ LES GOUTTES NE SE REVENDENT PAS ET NE SE RETIRENT PAS. C'est le choix
// de la « boucle fermée » (voir l'audit) : on en achète, on les dépense dans
// Droplet. Les cadeaux s'offrent mais ne se convertissent pas en Gouttes, et
// on n'envoie pas de Gouttes nues à quelqu'un : on lui offre un produit.
//
// Les prix sont ici, côté serveur, et nulle part ailleurs : l'app les lit sur
// `GET /v1/catalogue` et n'envoie jamais un prix, seulement une clé.
// ============================================================================

/** Les paliers de recharge. Montants entiers, en F CFA et en Gouttes. */
export const PALIERS = Object.freeze({
  g50: { montantXaf: 500n, gouttes: 50n },
  g100: { montantXaf: 1000n, gouttes: 100n },
  g250: { montantXaf: 2500n, gouttes: 260n },
  g500: { montantXaf: 5000n, gouttes: 530n },
});

/**
 * Les produits.
 *
 *   type 'abonnement' : un droit daté, prolongé s'il court déjà ;
 *   type 'definitif'  : un droit sans fin, achetable une seule fois ;
 *   type 'cadeau'     : un objet qu'on offre (ou qu'on garde), qui s'affiche
 *                       sur le profil. Il s'accumule : on peut en avoir dix.
 *
 * `famille` sert à l'app pour ranger la boutique.
 */
export const PRODUITS = Object.freeze({
  // ── Droplet Pro ──
  pro_30j: { famille: 'pro', type: 'abonnement', prix: 100n, jours: 30 },
  pro_365j: { famille: 'pro', type: 'abonnement', prix: 1000n, jours: 365 },

  // ── Personnalisation (définitif) ──
  pack_premium: { famille: 'personnalisation', type: 'definitif', prix: 50n },
  stickers_droplet: { famille: 'stickers', type: 'definitif', prix: 15n },
  stickers_gerbes: { famille: 'stickers', type: 'definitif', prix: 15n },
  stickers_personnage: { famille: 'stickers', type: 'definitif', prix: 15n },

  // ── Cadeaux, à la Telegram ──
  cadeau_goutte_doree: { famille: 'cadeaux', type: 'cadeau', prix: 25n },
  cadeau_bouquet: { famille: 'cadeaux', type: 'cadeau', prix: 50n },
  cadeau_comete: { famille: 'cadeaux', type: 'cadeau', prix: 100n },
});

/** Ce que sert `GET /v1/catalogue` : des chaînes pour les entiers. */
export function catalogueExpose() {
  const paliers = Object.entries(PALIERS).map(([cle, p]) => ({ cle, montantXaf: p.montantXaf.toString(), gouttes: p.gouttes.toString() }));
  const produits = Object.entries(PRODUITS).map(([cle, p]) => ({
    cle,
    famille: p.famille,
    type: p.type,
    prix: p.prix.toString(),
    ...(p.jours ? { jours: p.jours } : {}),
  }));
  return { version: 1, unite: 'goutte', paliers, produits };
}
