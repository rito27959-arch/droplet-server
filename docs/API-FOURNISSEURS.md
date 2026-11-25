# Les API des opérateurs : ce qui est sourcé, ce qui ne l'est pas

Relevé du 25 novembre 2026. Aucun appel n'a encore été fait aux vrais serveurs de MTN, d'Orange ou de Fapshi : les identifiants n'existent pas encore. Tout ce qui suit est vérifié **sur la documentation**, pas en conditions réelles.

## MTN MoMo — Collections (intégré, en direct)

| Élément | Valeur dans le code | Source |
| --- | --- | --- |
| Hôte du bac à sable | `https://sandbox.momodeveloper.mtn.com` | [Use cases, MTN](https://momodeveloper.mtn.com/content/html_widgets/1t1oe.html) |
| Créer une demande | `POST /collection/v1_0/requesttopay` → `202 Accepted` | Même page, et [Collection, MTN Rwanda](https://momodeveloper.mtn.co.rw/docs/services/collection) |
| En-têtes | `Authorization: Bearer`, `X-Reference-Id` (UUID v4), `X-Target-Environment`, `Ocp-Apim-Subscription-Key`, `X-Callback-Url` facultatif | Mêmes pages |
| Corps | `amount` (chaîne), `currency`, `externalId`, `payer.partyIdType`/`partyId`, `payerMessage`, `payeeNote` | [Collection, MTN Rwanda](https://momodeveloper.mtn.co.rw/docs/services/collection) |
| Statut | `GET /collection/v1_0/requesttopay/{X-Reference-Id}` : `PENDING` → `SUCCESSFUL` ou `FAILED` | [Use cases, MTN](https://momodeveloper.mtn.com/content/html_widgets/1t1oe.html) |
| Jeton | `POST /collection/token/`, Basic(utilisateur d'API:clé d'API) | La page officielle dit « `POST /token` » du produit ([API User and Key Management](https://momodeveloper.mtn.com/content/html_widgets/ouv7x.html)) ; le préfixe `/collection` vient de l'URL de base du produit ([SDK mtn-open-api](https://unpkg.com/mtn-open-api@1.0.0/README.md)). **À confirmer au premier appel.** |
| Provisionnement (bac à sable) | `POST {base}/apiuser`, puis `POST {base}/apiuser/{id}/apikey` | [API User and Key Management](https://momodeveloper.mtn.com/content/html_widgets/ouv7x.html) |
| Rappel | Envoyé une seule fois, sans nouvel essai ; HTTP en bac à sable, HTTPS en production ; même domaine que `providerCallbackHost` | [Callback, MTN](https://momodeveloper.mtn.com/content/html_widgets/kw4zc.html) |
| Devise du bac à sable | `EUR` uniquement | [Communauté MTN, réponse du modérateur](https://momodevelopercommunity.mtn.com/momo-api-sand-box-q-a-6/currency-not-supported-invalid-currency-258) |
| Production au Cameroun | Frais négociés (« de l'ordre de 1 % »), plafonds fixés par la BEAC ; identifiants donnés par le portail | [Collections, Cameroun](https://momoapi.mtn.com/Cameroon_Collection_productDetails) |

Non sourcé et donc **non utilisé** : les numéros de test du bac à sable et leurs résultats, le schéma exact de la réponse de statut (on lit `status`, et `amount` / `currency` seulement s'ils sont présents).

## Fapshi — agrégateur MTN et Orange (intégré)

Endpoints repris du Worker de licences déjà écrit (`serveur/index.js` de l'app), dont les commentaires disent qu'ils ont été vérifiés contre l'API : `POST direct-pay`, `GET payment-status/{transId}`, en-têtes `apiuser` / `apikey`, numéro en neuf chiffres, minimum 100 XAF. Hôte du bac à sable : `https://sandbox.fapshi.com/`.

## Orange Money Cameroun en direct — **non intégré**

La spécification marchande d'Orange Money Cameroun n'est pas publique : elle est remise avec le contrat marchand.

- [Orange Developer](https://developer.orange.com/apis/om-webpay) décrit le service et les conditions (marchand enregistré et conforme, approbation de la banque centrale), sans endpoints.
- Les intégrations camerounaises passent par `api-s1.orange.cm` (« omcoreapis »), en cours de migration vers une nouvelle plateforme, d'après [Paynote, août 2026](https://www.paynote.africa/mise-a-jour-technique-orange-money-guide-complet-de-migration-pour-vos-integrations-om-webpaiement/). Source tierce : non vérifiable sans compte.
- Un autre projet a reconstitué ces endpoints sans jamais les tester ([vpay, issue 331](https://github.com/vaam-apps/vpay/issues/331)).

Conformément à la spécification (« ne jamais inventer d'endpoints »), Orange passe par Fapshi tant que la spécification officielle n'a pas été obtenue. Le fournisseur `orange` existe déjà dans le code, déclaré indisponible.
