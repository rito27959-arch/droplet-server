// ============================================================================
// LE CATALOGUE — Droplet Credits (DC) et Droplet Store.
// ----------------------------------------------------------------------------
// Le catalogue vit dans la BASE : l'administration change un prix, retire un
// article, en ajoute un, sans redéployer. Ce fichier ne contient que la
// première grille, posée une fois au démarrage (`on conflict do nothing` :
// une modification faite depuis l'administration n'est jamais écrasée).
//
// 1 DC = 1 F CFA dans chaque pack. Les DC :
//   • ne se retirent pas et ne se revendent pas ;
//   • ne se transfèrent pas entre personnes (on offre un ARTICLE, jamais des DC) ;
//   • n'existent que sur le serveur : l'app affiche, elle ne compte pas.
//
// ⚠️ CHAQUE ARTICLE VENDU EST LIVRÉ PAR L'APP. On n'ajoute pas ici un genre
// que l'app ne sait pas appliquer (un « effet », un « son ») : ce serait
// vendre du vide. Les genres connus de l'app v1 :
//   cadre, style_nom, badge, theme, stickers, pack, premium, collection
// (« pro » reste compris par l'app pour les reçus anciens, mais n'est plus vendu).
// ============================================================================

const t = (fr, en) => ({ fr, en });

export const CATEGORIES = [
  { cle: 'identite', ordre: 1 },
  { cle: 'messenger', ordre: 2 },
  { cle: 'premium', ordre: 3 },
  { cle: 'collections', ordre: 4 },
];

export const COLLECTIONS = [
  { cle: 'harmattan', ordre: 1 },
  { cle: 'saison_des_pluies', ordre: 2 },
];

// (credit_packages.) Prix indicatifs de la spécification, réglables.
export const PALIERS = [
  { cle: 'starter', credits: 100, montantXaf: 100, ordre: 1 },
  { cle: 'standard', credits: 500, montantXaf: 500, ordre: 2 },
  { cle: 'premium', credits: 1000, montantXaf: 1000, ordre: 3 },
  { cle: 'ultimate', credits: 5000, montantXaf: 5000, ordre: 4 },
];

const VISIBLE_MOI = t(
  'Visible sur vos appareils Droplet. Vos contacts ne le voient pas encore.',
  'Visible on your Droplet devices. Your contacts can’t see it yet.',
);

export const PRODUITS = [
  // ── Identité ──
  { cle: 'cadre_goutte', categorie: 'identite', genre: 'cadre', prix: 0, ordre: 1,
    donnees: { motif: 'goutte', teintes: ['#8FC3FF', '#2F6BFF'],
      nom: t('Goutte', 'Drop'), texte: t('Un fin anneau d’eau autour de votre photo. Offert, pour découvrir la boutique.', 'A thin ring of water around your photo. Free, to discover the store.'), obtenu: VISIBLE_MOI } },
  { cle: 'cadre_orbite', categorie: 'identite', genre: 'cadre', prix: 75, ordre: 2, collection: 'saison_des_pluies',
    donnees: { motif: 'orbite', teintes: ['#B9F0FF', '#2AA7C9'],
      nom: t('Orbite', 'Orbit'), texte: t('Une goutte en orbite lente autour de votre photo.', 'A droplet slowly orbiting your photo.'), obtenu: VISIBLE_MOI } },
  { cle: 'cadre_sceau', categorie: 'identite', genre: 'cadre', prix: 75, ordre: 3, collection: 'harmattan',
    donnees: { motif: 'sceau', teintes: ['#F4D9A6', '#B9822F'],
      nom: t('Sceau', 'Seal'), texte: t('Un cercle gravé de douze traits, comme un cachet de cire.', 'A circle engraved with twelve marks, like a wax seal.'), obtenu: VISIBLE_MOI } },
  { cle: 'cadre_prisme', categorie: 'identite', genre: 'cadre', prix: 75, ordre: 4,
    donnees: { motif: 'prisme', teintes: ['#FFFFFF', '#9AA4B5'],
      nom: t('Prisme', 'Prism'), texte: t('Un anneau taillé à facettes, qui accroche la lumière quand le téléphone bouge.', 'A faceted ring that catches the light as the phone moves.'), obtenu: VISIBLE_MOI } },
  { cle: 'nom_grave', categorie: 'identite', genre: 'style_nom', prix: 60, ordre: 5, collection: 'harmattan',
    donnees: { style: 'grave',
      nom: t('Gravé', 'Engraved'), texte: t('Votre nom en capitales espacées, comme gravé dans le métal.', 'Your name in spaced capitals, as if engraved in metal.'), obtenu: VISIBLE_MOI } },
  { cle: 'nom_mono', categorie: 'identite', genre: 'style_nom', prix: 60, ordre: 6, collection: 'saison_des_pluies',
    donnees: { style: 'mono',
      nom: t('Machine', 'Machine'), texte: t('Votre nom en Martian Mono, la police technique de Droplet.', 'Your name in Martian Mono, Droplet’s technical typeface.'), obtenu: VISIBLE_MOI } },
  { cle: 'badge_comete', categorie: 'identite', genre: 'badge', prix: 50, ordre: 7,
    donnees: { forme: 'comete', teinte: '#6C51FF',
      nom: t('Comète', 'Comet'), texte: t('Un petit badge décoratif à côté de votre nom. Ce n’est pas une vérification.', 'A small decorative badge next to your name. It is not a verification.'), obtenu: VISIBLE_MOI } },
  { cle: 'badge_feuille', categorie: 'identite', genre: 'badge', prix: 50, ordre: 8,
    donnees: { forme: 'feuille', teinte: '#2FA36B',
      nom: t('Feuille', 'Leaf'), texte: t('Un badge décoratif en forme de feuille. Ce n’est pas une vérification.', 'A decorative leaf badge. It is not a verification.'), obtenu: VISIBLE_MOI } },

  // ── Messenger ──
  { cle: 'stickers_eclat', categorie: 'messenger', genre: 'stickers', prix: 50, ordre: 1,
    donnees: { lot: 'eclat',
      nom: t('Stickers Éclat', 'Éclat stickers'), texte: t('Les stickers animés « Éclat », avec leur effet plein écran.', 'The animated “Éclat” stickers, with their full-screen effect.'),
      obtenu: t('À vous pour toujours. Vos contacts les reçoivent animés.', 'Yours forever. Your contacts receive them animated.') } },
  { cle: 'theme_encre', categorie: 'messenger', genre: 'theme', prix: 100, ordre: 2, nouveau: true,
    donnees: { sortant: '#2B3A67', texteSortant: '#FFFFFF', entrant: '#1B1F2A', texteEntrant: '#E8ECF5',
      nom: t('Encre', 'Ink'), texte: t('Des bulles bleu nuit, pour lire tard sans s’éblouir.', 'Midnight-blue bubbles, for reading late without glare.'),
      obtenu: t('Change vos bulles dans toutes vos conversations, sur vos appareils.', 'Changes your bubbles in every chat, on your devices.') } },
  { cle: 'theme_sable', categorie: 'messenger', genre: 'theme', prix: 100, ordre: 3, nouveau: true, collection: 'harmattan',
    donnees: { sortant: '#C98B3B', texteSortant: '#1E1408', entrant: '#2A2420', texteEntrant: '#F3E7D6',
      nom: t('Sable', 'Sand'), texte: t('Les couleurs d’un après-midi d’harmattan.', 'The colours of a harmattan afternoon.'),
      obtenu: t('Change vos bulles dans toutes vos conversations, sur vos appareils.', 'Changes your bubbles in every chat, on your devices.') } },
  { cle: 'theme_lagune', categorie: 'messenger', genre: 'theme', prix: 100, ordre: 4, nouveau: true, collection: 'saison_des_pluies',
    donnees: { sortant: '#137A7F', texteSortant: '#FFFFFF', entrant: '#13252A', texteEntrant: '#D7F1F2',
      nom: t('Lagune', 'Lagoon'), texte: t('Vert d’eau profonde, après la pluie.', 'Deep-water green, after the rain.'),
      obtenu: t('Change vos bulles dans toutes vos conversations, sur vos appareils.', 'Changes your bubbles in every chat, on your devices.') } },
  { cle: 'pack_premium', categorie: 'messenger', genre: 'pack', prix: 500, ordre: 5,
    donnees: {
      nom: t('Icônes et fonds', 'Icons & wallpapers'), texte: t('Les icônes d’app et les fonds premium de Droplet, avec les stickers Éclat.', 'Droplet’s premium app icons and wallpapers, with the Éclat stickers.'),
      obtenu: t('Le même pack qu’aujourd’hui, à vous pour toujours.', 'The same pack as today, yours forever.') } },

  // ── Premium : remplace Droplet Pro dans le Store ──
  // Tout ce que Pro donnait, pour 30 jours. Pas de renouvellement
  // automatique : on rachète pour prolonger, et la nouvelle période
  // commence à la fin de la précédente. Les licences Pro déjà payées
  // restent valables dans l'app.
  { cle: 'premium_30j', categorie: 'premium', genre: 'premium', type: 'abonnement', jours: 30, prix: 500, ordre: 1, mis_en_avant: true,
    donnees: {
      nom: t('Droplet Premium', 'Droplet Premium'),
      texte: t('Vocaux en texte, traduction sur le téléphone, mise en forme, icônes et fonds premium, stickers Éclat et badge. Pour 30 jours.', 'Voice-to-text, on-device translation, formatting, premium icons and wallpapers, Éclat stickers and badge. For 30 days.'),
      obtenu: t('30 jours, puis il s’arrête. Rien n’est prélevé sans vous : rachetez pour prolonger.', '30 days, then it stops. Nothing is charged without you: buy again to extend.') } },

  // ── Collections : moins cher que les articles un par un, pour de vrai ──
  { cle: 'col_harmattan', categorie: 'collections', genre: 'collection', type: 'collection', prix: 199, ordre: 1, collection: 'harmattan',
    articles: ['theme_sable', 'cadre_sceau', 'nom_grave'],
    donnees: {
      nom: t('Harmattan', 'Harmattan'), texte: t('Le thème Sable, le cadre Sceau et le nom Gravé, ensemble.', 'The Sand theme, the Seal frame and the Engraved name, together.'),
      obtenu: t('Trois articles (235 DC séparément). Ceux que vous avez déjà ne sont pas refacturés.', 'Three items (235 DC separately). Items you already own aren’t charged again.') } },
  { cle: 'col_pluies', categorie: 'collections', genre: 'collection', type: 'collection', prix: 199, ordre: 2, collection: 'saison_des_pluies',
    articles: ['theme_lagune', 'cadre_orbite', 'nom_mono'],
    donnees: {
      nom: t('Saison des pluies', 'Rainy season'), texte: t('Le thème Lagune, le cadre Orbite et le nom Machine.', 'The Lagoon theme, the Orbit frame and the Machine name.'),
      obtenu: t('Trois articles (235 DC séparément). Ceux que vous avez déjà ne sont pas refacturés.', 'Three items (235 DC separately). Items you already own aren’t charged again.') } },
];

/** Pose la première grille. Ne modifie jamais ce qui existe déjà. */
export async function semerCatalogue(c) {
  for (const k of CATEGORIES) await c.query('insert into categories (cle, ordre) values ($1, $2) on conflict do nothing', [k.cle, k.ordre]);
  for (const k of COLLECTIONS) await c.query('insert into collections (cle, ordre) values ($1, $2) on conflict do nothing', [k.cle, k.ordre]);
  for (const p of PALIERS) {
    await c.query('insert into paliers (cle, credits, montant_xaf, ordre) values ($1, $2, $3, $4) on conflict do nothing', [p.cle, p.credits, p.montantXaf, p.ordre]);
  }
  for (const p of PRODUITS) {
    const ins = await c.query(
      `insert into produits (cle, categorie, genre, type, prix, jours, collection, statut, ordre, nouveau, mis_en_avant, donnees)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict do nothing`,
      [p.cle, p.categorie, p.genre, p.type ?? 'definitif', p.prix, p.jours ?? null, p.collection ?? null, p.statut ?? 'publie',
        p.ordre ?? 0, p.nouveau ?? false, p.mis_en_avant ?? false, p.donnees],
    );
    if (ins.rowCount) await c.query("insert into prix_historique (produit, prix, par) values ($1, $2, 'semence')", [p.cle, p.prix]);
  }
  for (const p of PRODUITS.filter((x) => x.articles)) {
    for (const a of p.articles) {
      await c.query('insert into collection_articles (produit_collection, produit) values ($1, $2) on conflict do nothing', [p.cle, a]);
    }
  }
}

export async function lirePalier(c, cle) {
  const r = await c.query('select cle, credits, montant_xaf from paliers where cle = $1 and actif', [cle]);
  if (!r.rowCount) return null;
  return { cle, credits: r.rows[0].credits, montantXaf: r.rows[0].montant_xaf };
}

/** Un produit en vente (publié), avec les articles d'une collection. */
export async function lireProduit(c, cle) {
  const r = await c.query("select * from produits where cle = $1 and statut = 'publie'", [cle]);
  if (!r.rowCount) return null;
  const p = r.rows[0];
  if (p.type === 'collection') {
    const a = await c.query('select produit from collection_articles where produit_collection = $1 order by produit', [cle]);
    p.articles = a.rows.map((x) => x.produit);
  }
  return p;
}

const exposerProduit = (p) => ({
  cle: p.cle,
  categorie: p.categorie,
  genre: p.genre,
  type: p.type,
  prix: p.prix.toString(),
  ...(p.jours ? { jours: p.jours } : {}),
  collection: p.collection,
  createur: p.createur_nom ? { id: p.createur, nom: p.createur_nom } : null,
  nouveau: p.nouveau,
  misEnAvant: p.mis_en_avant,
  articles: p.articles ?? undefined,
  donnees: p.donnees,
});

/** Ce que sert `GET /v1/catalogue`. Les entiers voyagent en chaînes. */
export async function catalogueExpose(c) {
  const [cats, cols, prods, arts, pals] = await Promise.all([
    c.query('select cle from categories order by ordre'),
    c.query('select cle from collections where active order by ordre'),
    c.query(`select p.*, cr.nom_public as createur_nom from produits p left join createurs cr on cr.id = p.createur
              where p.statut = 'publie' and (cr.id is null or cr.statut = 'actif') order by p.categorie, p.ordre, p.cle`),
    c.query('select produit_collection, produit from collection_articles order by produit'),
    c.query('select cle, credits, montant_xaf from paliers where actif order by ordre'),
  ]);
  const articles = new Map();
  for (const a of arts.rows) articles.set(a.produit_collection, [...(articles.get(a.produit_collection) ?? []), a.produit]);
  // Les populaires : les plus vendus des 30 derniers jours, sans inventer.
  const pop = await c.query(
    `select o.details->>'produit' as cle, count(*)::int as n from operations o
      where o.nature in ('achat', 'cadeau') and o.cree_le > now() - interval '30 days'
        and not exists (select 1 from operations r where r.reference = 'remboursement:' || o.id)
      group by 1 order by n desc limit 8`,
  );
  return {
    version: 2,
    unite: 'dc',
    categories: cats.rows.map((x) => x.cle),
    collections: cols.rows.map((x) => x.cle),
    paliers: pals.rows.map((p) => ({ cle: p.cle, credits: p.credits.toString(), montantXaf: p.montant_xaf.toString() })),
    produits: prods.rows.map((p) => exposerProduit({ ...p, articles: articles.get(p.cle) })),
    populaires: pop.rows.map((x) => x.cle),
  };
}
