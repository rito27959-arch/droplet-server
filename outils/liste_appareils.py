"""Lit, sur l'annuaire déployé, la liste publique des appareils liés d'un compte."""
import json, sys, urllib.request
for pid in sys.argv[1:]:
    try:
        r = urllib.request.urlopen(f'https://droplet-directory-production.up.railway.app/appareils/{pid}/liste', timeout=10)
        j = json.loads(r.read())
        print(pid[:8], 'md =', j.get('md'), '| appareils :', len(j.get('appareils', [])), '| pseudo présent :', bool(j.get('pseudo')))
    except Exception as e:
        print(pid[:8], 'erreur', e)
