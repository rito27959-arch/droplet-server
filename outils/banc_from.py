"""Banc d'essai EN DIRECT du serveur d'appels : un pair peut-il parler au
nom d'un autre ? (champ « from » usurpé). Lancé par GitHub Actions, contre
le serveur déployé sur Railway. Deux pairs de test, une salle jetable
(jamais une boîte d'appel `inbox_`, pour ne réveiller personne)."""
import asyncio, json, secrets, sys, urllib.request
import websockets

URL = 'droplet-server-production.up.railway.app'
salle = 'banc_' + secrets.token_hex(8)
A, B, C = (secrets.token_hex(32) for _ in range(3))
resultats = []

def noter(nom, ok, detail=''):
    resultats.append((nom, ok))
    print(('OK   ' if ok else 'ÉCHEC'), nom, detail, flush=True)

async def rejoindre(ws, pid):
    await ws.send(json.dumps({'type': 'join', 'peerId': pid}))
    while True:
        m = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if m.get('type') in ('joined', 'error'):
            return m

async def recu_dans(ws, delai=3.0):
    """Tous les messages reçus pendant [delai] secondes (hors annonces de salle)."""
    vus = []
    try:
        while True:
            m = json.loads(await asyncio.wait_for(ws.recv(), delai))
            if m.get('type') in ('offer', 'answer', 'ice-candidate'):
                vus.append(m)
    except asyncio.TimeoutError:
        pass
    return vus

async def main():
    sante = json.loads(urllib.request.urlopen(f'https://{URL}/health', timeout=10).read())
    noter('le serveur annonce « from-verifie »', 'from-verifie' in sante.get('fonctions', []), str(sante.get('fonctions')))

    async with websockets.connect(f'wss://{URL}/ws/{salle}') as wa, websockets.connect(f'wss://{URL}/ws/{salle}') as wb:
        ra = await rejoindre(wa, A)
        rb = await rejoindre(wb, B)
        if ra.get('type') != 'joined' or rb.get('type') != 'joined':
            noter('entrée de deux pairs de test', False, f'{ra} {rb}')
            return
        noter('entrée de deux pairs de test', True)
        await recu_dans(wa, 1.5); await recu_dans(wb, 1.5)  # annonces « peer-joined »

        # 1. Témoin : A parle en son nom → B doit recevoir.
        await wa.send(json.dumps({'type': 'offer', 'from': A, 'to': B, 'sdp': {'type': 'offer', 'sdp': 'v=0 témoin'}}))
        vus = await recu_dans(wb)
        noter('témoin : une offre signée de son propre nom passe', any(m.get('from') == A for m in vus), f'{len(vus)} reçue(s)')

        # 2. A se fait passer pour B (l'appelé lui-même) → rien ne doit arriver.
        await wa.send(json.dumps({'type': 'answer', 'from': B, 'to': B, 'sdp': {'type': 'answer', 'sdp': 'v=0 usurpé'}}))
        # 3. A se fait passer pour un tiers C.
        await wa.send(json.dumps({'type': 'offer', 'from': C, 'to': B, 'sdp': {'type': 'offer', 'sdp': 'v=0 usurpé'}}))
        # 4. Candidat ICE au nom de B.
        await wa.send(json.dumps({'type': 'ice-candidate', 'from': B, 'to': B, 'candidate': {'candidate': 'usurpé'}}))
        # 5. Sans « from » du tout.
        await wa.send(json.dumps({'type': 'offer', 'to': B, 'sdp': {'type': 'offer', 'sdp': 'v=0 sans from'}}))
        vus = await recu_dans(wb, 4)
        usurpes = [m for m in vus if m.get('from') != A]
        noter('usurpations (réponse au nom de B, offre au nom de C, ICE au nom de B, sans from) : toutes jetées', not usurpes and not vus, f'{len(vus)} reçue(s) : {[m.get("type") + "/" + str(m.get("from"))[:8] for m in vus]}')

        # 6. La connexion de A reste utilisable (le serveur jette, il ne coupe pas).
        await wa.send(json.dumps({'type': 'offer', 'from': A, 'to': B, 'sdp': {'type': 'offer', 'sdp': 'v=0 après'}}))
        vus = await recu_dans(wb)
        noter('après les tentatives, les vrais messages passent toujours', any(m.get('from') == A for m in vus))
        for ws in (wa, wb):
            await ws.send(json.dumps({'type': 'leave'}))

asyncio.run(main())
echecs = [n for n, ok in resultats if not ok]
print('RÉSULTAT', 'OK' if resultats and not echecs else 'ÉCHEC', f'({len(resultats)} vérifications)')
sys.exit(1 if echecs or not resultats else 0)
