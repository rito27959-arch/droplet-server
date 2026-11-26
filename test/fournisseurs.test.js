// Ces tests vérifient la FORME des requêtes envoyées à MTN et à Fapshi
// (chemins, en-têtes, corps), contre un serveur local qui les enregistre.
// ⚠️ Ce n'est PAS un test contre les vrais serveurs de MTN ou de Fapshi.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';

import { creerFapshi } from '../src/fournisseurs/fapshi.js';
import { creerMtn } from '../src/fournisseurs/mtn.js';
import { masquer, numeroLocal } from '../src/fournisseurs/telephone.js';

let serveur;
let base;
const recues = [];
let reponses = {};

before(async () => {
  serveur = http.createServer((req, res) => {
    let corps = '';
    req.on('data', (m) => (corps += m));
    req.on('end', () => {
      recues.push({ methode: req.method, chemin: req.url, entetes: req.headers, corps });
      const [statut, json] = reponses[`${req.method} ${req.url}`] ?? [404, {}];
      res.writeHead(statut, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${serveur.address().port}`;
});
after(() => serveur.close());

test('numéros : neuf chiffres locaux, indicatif accepté en entrée', () => {
  assert.equal(numeroLocal('+237 699-00-11-22'), '699001122');
  assert.equal(numeroLocal('237699001122'), '699001122');
  assert.equal(numeroLocal('599001122'), null);
  assert.equal(numeroLocal('69900112'), null);
  assert.equal(masquer('699001122'), '69•••••22');
});

test('MTN : jeton, RequestToPay puis statut, conformes à la documentation', async () => {
  recues.length = 0;
  const ref = '3f1c2a8e-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
  reponses = {
    'POST /collection/token/': [200, { access_token: 'jeton-123', token_type: 'access_token', expires_in: 3600 }],
    'POST /collection/v1_0/requesttopay': [202, {}],
    [`GET /collection/v1_0/requesttopay/${ref}`]: [200, { amount: '1000', currency: 'EUR', externalId: ref, status: 'SUCCESSFUL' }],
  };
  const mtn = creerMtn(
    { environnement: 'sandbox', base, cleAbonnement: 'abo', apiUser: 'user-uuid', apiKey: 'cle-api', devise: 'EUR' },
    { adressePublique: 'https://pay.exemple' },
  );
  assert.equal(mtn.disponible, true);

  const { refFournisseur } = await mtn.initier({ reference: ref, montant: 1000n, telephone: '677001122', description: 'Droplet Credits' });
  assert.equal(refFournisseur, ref);

  const [tok, rtp] = recues;
  assert.equal(tok.chemin, '/collection/token/');
  assert.equal(tok.entetes.authorization, `Basic ${Buffer.from('user-uuid:cle-api').toString('base64')}`);
  assert.equal(tok.entetes['ocp-apim-subscription-key'], 'abo');

  assert.equal(rtp.chemin, '/collection/v1_0/requesttopay');
  assert.equal(rtp.entetes.authorization, 'Bearer jeton-123');
  assert.equal(rtp.entetes['x-reference-id'], ref);
  assert.equal(rtp.entetes['x-target-environment'], 'sandbox');
  assert.equal(rtp.entetes['x-callback-url'], `https://pay.exemple/v1/rappels/mtn/${ref}`);
  assert.deepEqual(JSON.parse(rtp.corps), {
    amount: '1000',
    currency: 'EUR',
    externalId: ref,
    payer: { partyIdType: 'MSISDN', partyId: '237677001122' },
    payerMessage: 'Droplet Credits',
    payeeNote: 'Droplet Credits',
  });

  const s = await mtn.statut(ref);
  assert.deepEqual(s, { etat: 'reussie', montant: 1000n, devise: 'EUR', message: null });
  // Le jeton est réutilisé, pas redemandé à chaque appel.
  assert.equal(recues.filter((r) => r.chemin === '/collection/token/').length, 1);
});

test('MTN : un refus 4xx remonte avec le code de MTN', async () => {
  reponses['POST /collection/v1_0/requesttopay'] = [400, { code: 'PAYER_NOT_FOUND', message: 'Payer not found' }];
  const mtn = creerMtn({ environnement: 'sandbox', base, cleAbonnement: 'a', apiUser: 'u', apiKey: 'k', devise: 'EUR' });
  await assert.rejects(mtn.initier({ reference: 'r', montant: 1n, telephone: '677001122', description: 'x' }), (e) => e.codeFournisseur === 'PAYER_NOT_FOUND');
});

test('MTN : sans identifiants, le fournisseur se déclare indisponible', () => {
  assert.equal(creerMtn({ environnement: 'sandbox', base, cleAbonnement: '', apiUser: '', apiKey: '' }).disponible, false);
});

test('Fapshi : direct-pay et payment-status, conformes au Worker existant', async () => {
  recues.length = 0;
  reponses = {
    'POST /direct-pay': [200, { message: 'Request successful', transId: 'T123abc' }],
    'GET /payment-status/T123abc': [200, { transId: 'T123abc', status: 'SUCCESSFUL', amount: 500, externalId: 'ref-1' }],
  };
  const f = creerFapshi({ base: `${base}/`, apiUser: 'au', apiKey: 'ak' });
  const { refFournisseur } = await f.initier({ reference: 'ref-1', montant: 500n, telephone: '699001122', description: 'Droplet Credits' });
  assert.equal(refFournisseur, 'T123abc');
  assert.equal(recues[0].entetes.apiuser, 'au');
  assert.equal(recues[0].entetes.apikey, 'ak');
  assert.deepEqual(JSON.parse(recues[0].corps), { amount: 500, phone: '699001122', externalId: 'ref-1', message: 'Droplet Credits' });

  assert.equal((await f.statut('T123abc', 'ref-1')).etat, 'reussie');
  // Une transaction réussie qui n'est pas la nôtre n'est pas prise.
  assert.equal((await f.statut('T123abc', 'ref-autre')).etat, 'inconnu');
  await assert.rejects(f.initier({ reference: 'x', montant: 50n, telephone: '699001122', description: 'x' }), /100 XAF/);
});
