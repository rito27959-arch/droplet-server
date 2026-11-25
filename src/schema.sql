-- ============================================================================
-- DROPLET PAY — le schéma.
-- ----------------------------------------------------------------------------
-- Trois règles tiennent tout le reste, et elles sont dans la BASE, pas dans le
-- code : un bug applicatif ne peut pas les contourner.
--
--   1. Partie double. Chaque opération écrit des lignes dont la somme est 0
--      (contrainte différée `ecritures_equilibrees`).
--   2. Pas de découvert. Le solde d'un portefeuille ne descend jamais sous 0
--      (CHECK sur `comptes_registre`, tenu à jour par déclencheur dans la
--      même transaction que l'écriture).
--   3. Rien ne s'efface. Les écritures et le journal refusent UPDATE et DELETE.
--      Une erreur se corrige par une nouvelle opération (nature `correction`).
--
-- Tous les montants sont des ENTIERS (bigint) : des Gouttes, ou des francs
-- CFA pour ce qui vient des opérateurs. Aucun nombre à virgule nulle part.
-- ============================================================================

create table if not exists comptes (
  id          text primary key,                 -- le `sub` Droplet ID propre à Pay
  cree_le     timestamptz not null default now()
);

create table if not exists appareils (
  id          text primary key,                 -- identifiant d'appareil Droplet ID
  compte      text not null references comptes(id),
  cle_pub     text not null,                    -- Ed25519 brute, base64url
  cree_le     timestamptz not null default now(),
  revoque_le  timestamptz
);
create index if not exists appareils_compte on appareils (compte);

create table if not exists nonces (
  nonce       text primary key,
  vu_le       timestamptz not null default now()
);

-- ── Le registre ─────────────────────────────────────────────────────────────

create table if not exists comptes_registre (
  id          bigserial primary key,
  code        text unique not null,             -- 'portefeuille:<compte>', 'compensation:mtn', 'produits'
  nature      text not null check (nature in ('portefeuille', 'compensation', 'produits')),
  compte      text references comptes(id),
  solde       bigint not null default 0,
  constraint pas_de_decouvert check (nature <> 'portefeuille' or solde >= 0),
  constraint portefeuille_a_un_titulaire check ((nature = 'portefeuille') = (compte is not null))
);

create table if not exists operations (
  id          uuid primary key,
  nature      text not null check (nature in ('recharge', 'achat', 'cadeau', 'remboursement', 'correction')),
  -- Une opération par fait réel : 'recharge:<id>', 'achat:<compte>:<clé>'.
  -- C'est l'unicité de cette colonne qui empêche de créditer deux fois.
  reference   text unique not null,
  cree_le     timestamptz not null default now(),
  details     jsonb not null default '{}'
);

create table if not exists ecritures (
  id               bigserial primary key,
  operation        uuid not null references operations(id),
  compte_registre  bigint not null references comptes_registre(id),
  montant          bigint not null check (montant <> 0)   -- + crédit, − débit
);
create index if not exists ecritures_operation on ecritures (operation);
create index if not exists ecritures_compte on ecritures (compte_registre, id desc);

create or replace function appliquer_ecriture() returns trigger language plpgsql as $$
begin
  update comptes_registre set solde = solde + new.montant where id = new.compte_registre;
  return new;
end $$;

drop trigger if exists ecriture_appliquee on ecritures;
create trigger ecriture_appliquee after insert on ecritures
  for each row execute function appliquer_ecriture();

create or replace function verifier_equilibre() returns trigger language plpgsql as $$
declare total bigint;
begin
  select coalesce(sum(montant), 0) into total from ecritures where operation = new.operation;
  if total <> 0 then
    raise exception 'operation % desequilibree (somme %)', new.operation, total
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists ecritures_equilibrees on ecritures;
create constraint trigger ecritures_equilibrees after insert on ecritures
  deferrable initially deferred
  for each row execute function verifier_equilibre();

create or replace function interdire_modification() returns trigger language plpgsql as $$
begin
  raise exception '% est en ajout seul', tg_table_name using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists ecritures_immuables on ecritures;
create trigger ecritures_immuables before update or delete on ecritures
  for each row execute function interdire_modification();

-- ── Recharges (argent réel → Gouttes) ───────────────────────────────────────

create table if not exists recharges (
  id                uuid primary key,
  compte            text not null references comptes(id),
  palier            text not null,
  montant_xaf       bigint not null check (montant_xaf > 0),
  gouttes           bigint not null check (gouttes > 0),
  fournisseur       text not null,
  devise            text not null,             -- ce qui est demandé à l'opérateur (XAF ; EUR en sandbox MTN)
  telephone_masque  text not null,
  ref_fournisseur   text,
  etat              text not null check (etat in ('creee', 'en_attente', 'reussie', 'echouee', 'a_verifier')),
  message           text,
  cree_le           timestamptz not null default now(),
  maj_le            timestamptz not null default now(),
  unique (fournisseur, ref_fournisseur)
);
create index if not exists recharges_attente on recharges (etat, cree_le) where etat in ('creee', 'en_attente', 'a_verifier');
create index if not exists recharges_compte on recharges (compte, cree_le desc);

-- ── Droits (ce qui a été acheté) ────────────────────────────────────────────

create table if not exists droits (
  id          uuid primary key,
  compte      text not null references comptes(id),   -- qui en profite
  produit     text not null,
  debut       timestamptz not null,
  fin         timestamptz,                            -- null = définitif
  operation   uuid not null references operations(id),
  offert_par  text references comptes(id),
  cree_le     timestamptz not null default now()
);
create index if not exists droits_compte on droits (compte, produit);

-- ── Idempotence ─────────────────────────────────────────────────────────────

create table if not exists idempotence (
  compte      text not null,
  cle         text not null,
  empreinte   text not null,            -- sha256 de méthode + chemin + corps
  statut      int,
  reponse     jsonb,
  cree_le     timestamptz not null default now(),
  primary key (compte, cle)
);

-- ── Journal d'audit, chaîné ─────────────────────────────────────────────────

create table if not exists journal (
  id          bigserial primary key,
  quand       timestamptz not null default now(),
  acteur      text not null,
  action      text not null,
  details     jsonb not null default '{}',
  hash_prec   text not null,
  hash        text not null
);

drop trigger if exists journal_immuable on journal;
create trigger journal_immuable before update or delete on journal
  for each row execute function interdire_modification();

-- Les comptes système, créés une fois.
insert into comptes_registre (code, nature) values ('produits', 'produits') on conflict do nothing;
