// ============================================================================
// DROPLET SERVER (RAILWAY)
// ============================================================================
// Serveur de signaling WebRTC + TURN pour les appels audio/vidéo.
//
// Endpoints :
//   GET  /health           — Health check
//   WS   /ws/:roomId      — WebSocket signaling pour une salle
//   POST /turn/credentials — Credentials TURN temporaires
// ============================================================================

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as io;
import 'package:shelf_router/shelf_router.dart';
import 'package:shelf_web_socket/shelf_web_socket.dart';
import 'package:args/args.dart';
import 'package:http/http.dart' as http;

/// Préfixe des salles d'appel personnelles — voir la note sur
/// `_handleWebSocket` et le cas `'join'` : chaque appareil rejoint la
/// sienne en continu (`inbox_<monPeerId>`) pour être joignable même sans
/// coordination préalable avec l'appelant.
const _prefixeBoiteAppel = 'inbox_';

/// URL du serveur annuaire — seul des trois petits serveurs Droplet à
/// porter le secret Firebase (voir `droplet_directory/lib/fcm.dart`).
final String _directoryUrl = Platform.environment['DIRECTORY_URL'] ??
    'https://droplet-directory-production.up.railway.app';
final _httpClient = http.Client();

/// Réveille [destinataireId] par notification push — appelé quand
/// quelqu'un rejoint SA boîte d'appel alors qu'il n'y est pas déjà (voir
/// le cas `'join'`). Jamais attendu, jamais laissé faire échouer la
/// mise en relation WebRTC elle-même : un push qui échoue ne doit pas
/// empêcher l'offre d'être diffusée normalement à qui écoute.
void _reveillerParPush(String destinataireId, {required String appelantId}) {
  unawaited(() async {
    try {
      await _httpClient.post(
        Uri.parse('$_directoryUrl/notify'),
        headers: {
          'Content-Type': 'application/json',
          // Seuls nos serveurs peuvent réveiller un téléphone (voir l'annuaire).
          'x-cle-interne': _cleInterne,
        },
        body: jsonEncode({
          'peerId': destinataireId,
          'title': 'Appel entrant',
          // ⚠️ Générique à dessein : ce serveur ne connaît aucun pseudo,
          // seulement des identifiants techniques — les afficher tels
          // quels ferait plus de mal que de bien.
          'body': 'Quelqu\'un essaie de vous joindre par Droplet',
          'data': {'type': 'call', 'from': appelantId},
        }),
      ).timeout(const Duration(seconds: 10));
    } catch (e) {
      print('[Server] Échec réveil push (sans conséquence): $e');
    }
  }());
}

// ── Modèle de salle ────────────────────────────────────────────────

class Room {
  Room({required this.id});

  final String id;
  final Map<String, dynamic> _peers = {};

  void addPeer(String peerId, dynamic channel) {
    _peers[peerId] = channel;
  }

  void removePeer(String peerId) {
    _peers.remove(peerId);
  }

  void broadcast(String fromPeerId, String message) {
    for (final entry in _peers.entries) {
      if (entry.key != fromPeerId) {
        try {
          entry.value.sink.add(message);
        } catch (_) {}
      }
    }
  }

  List<String> peerIdsExcept(String? excludeId) {
    return _peers.keys.where((id) => id != excludeId).toList();
  }

  int get peerCount => _peers.length;
}

// ── Serveur ────────────────────────────────────────────────────────

final _rooms = <String, Room>{};

Room _getOrCreateRoom(String roomId) {
  return _rooms.putIfAbsent(roomId, () => Room(id: roomId));
}

final _router = Router()
  ..get('/health', _handleHealth)
  ..post('/turn/credentials', _handleTurnCredentials)
  ..get('/ws/<roomId>', _handleWebSocket);

// ⚠️ LA ROUTE WEBSOCKET NE PASSE JAMAIS PAR `logRequests()`.
//
// `shelf_web_socket` transforme la connexion HTTP en connexion WebSocket
// via un « hijack » bas niveau (elle prend directement la main sur le
// socket TCP, en dehors du système normal requête→réponse de `shelf`).
// `logRequests()` lit la réponse renvoyée par le gestionnaire pour
// l'écrire dans les logs — mais un hijack n'en renvoie aucune, il
// lève un signal interne (`HijackException`) que la mise à niveau attend
// de voir remonter INTACT jusqu'à `shelf_io.serve`. Une middleware posée
// entre les deux peut interférer avec ce signal, et la mise à niveau
// échoue alors avec un 500 générique — avant même d'atteindre le code de
// la salle. On sépare donc explicitement : le WebSocket rejoint le
// routeur directement, tout le reste (santé, identifiants TURN) passe
// par la version journalisée.
final _loggedRouter = const Pipeline()
    .addMiddleware(logRequests())
    .addHandler(_router.call);

FutureOr<Response> _dispatch(Request request) async {
  if (request.url.path.startsWith('ws/')) {
    return _router.call(request);
  }
  // Droplet Web demande ses identifiants de relais depuis le navigateur :
  // sans ces en-têtes, la requête est bloquée avant de partir.
  final cors = _entetesCors(request);
  if (request.method == 'OPTIONS') return Response(204, headers: cors);
  final reponse = await _loggedRouter(request);
  return cors.isEmpty ? reponse : reponse.change(headers: cors);
}

/// Les origines de Droplet Web (et ses aperçus Vercel).
Map<String, String> _entetesCors(Request r) {
  final o = r.headers['origin'];
  if (o == null) return const {};
  final permis = o == 'https://web.dropletmesh.app' ||
      o == 'https://dropletmesh.app' ||
      o.endsWith('.vercel.app') ||
      o.startsWith('http://localhost:');
  if (!permis) return const {};
  return {
    'access-control-allow-origin': o,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
}

// ── Health Check ───────────────────────────────────────────────────

Response _handleHealth(Request request) {
  return Response.ok(
    jsonEncode({
      'status': 'ok',
      'rooms': _rooms.length,
      'totalPeers': _rooms.values.fold(0, (sum, r) => sum + r.peerCount),
      'uptime': DateTime.now().toIso8601String(),
    }),
    headers: {'content-type': 'application/json'},
  );
}

// ── TURN Credentials ───────────────────────────────────────────────

/// Relais TURN : identifiants TEMPORAIRES générés par Cloudflare.
///
/// ⚠️ LA VERSION PRÉCÉDENTE RENVOYAIT UN RELAIS FACTICE. `turn.droplet.app`
/// n'existe pas (le nom ne résout pas), et le « secret » était codé en dur.
/// Aucun appel par Internet ne pouvait donc passer par un relais — or entre
/// deux réseaux mobiles, qui bloquent presque toujours la connexion directe,
/// c'est le seul chemin possible pour le son et l'image.
///
/// Configuration Railway (jamais dans le code) :
///   CLOUDFLARE_TURN_KEY_ID      — identifiant de la clé TURN
///   CLOUDFLARE_TURN_API_TOKEN   — jeton d'API de cette clé
/// Sans elles, la liste renvoyée est VIDE : l'app tente alors la connexion
/// directe (STUN) plutôt qu'un relais inexistant.
///
/// Les identifiants sont mis en cache (valables 24 h, renouvelés après 12 h) :
/// un appel ne coûte pas un aller-retour vers Cloudflare.
Map<String, dynamic>? _turnEnCache;
DateTime? _turnExpire;

Future<Response> _handleTurnCredentials(Request request) async {
  final keyId = Platform.environment['CLOUDFLARE_TURN_KEY_ID'] ?? '';
  final jeton = Platform.environment['CLOUDFLARE_TURN_API_TOKEN'] ?? '';
  const entetes = {'content-type': 'application/json', 'cache-control': 'no-store'};

  if (keyId.isEmpty || jeton.isEmpty) {
    return Response.ok(jsonEncode({'iceServers': []}), headers: entetes);
  }

  final maintenant = DateTime.now();
  if (_turnEnCache != null && _turnExpire != null && maintenant.isBefore(_turnExpire!)) {
    return Response.ok(jsonEncode(_turnEnCache), headers: entetes);
  }

  try {
    final r = await _httpClient
        .post(
          Uri.parse('https://rtc.live.cloudflare.com/v1/turn/keys/$keyId/credentials/generate-ice-servers'),
          headers: {
            'Authorization': 'Bearer $jeton',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({'ttl': 86400}),
        )
        .timeout(const Duration(seconds: 8));
    if (r.statusCode != 200 && r.statusCode != 201) {
      print('[Server] Cloudflare TURN a répondu ${r.statusCode}');
      return Response.ok(jsonEncode({'iceServers': []}), headers: entetes);
    }
    final corps = jsonDecode(r.body) as Map<String, dynamic>;
    _turnEnCache = {'iceServers': corps['iceServers'] ?? []};
    _turnExpire = maintenant.add(const Duration(hours: 12));
    return Response.ok(jsonEncode(_turnEnCache), headers: entetes);
  } catch (e) {
    print('[Server] Identifiants TURN indisponibles: $e');
    return Response.ok(jsonEncode({'iceServers': []}), headers: entetes);
  }
}

// ── Sécurité et limites ────────────────────────────────────────────
//
// • IDENTITÉ. Entrer dans une salle, c'est dire « je suis X ». Depuis la
//   version de l'app qui signe, le message `join` porte `ts` et `sig` :
//   la signature de X sur « GET /ws/<salle> <heure> <nonce> » (voir
//   droplet_directory/lib/securite.dart). Le serveur la fait vérifier par
//   l'annuaire, qui seul connaît la clé de X. Un identifiant qui a déjà
//   signé une fois ne peut plus entrer sans signature : personne ne peut
//   s'asseoir dans la boîte d'appel de quelqu'un d'autre pour intercepter
//   ses appels, ni appeler en se faisant passer pour lui.
// • LIMITES. Connexions par adresse IP, messages par seconde, taille d'un
//   message, nombre de personnes par boîte d'appel : un client fou ne
//   peut pas mettre le serveur à genoux.
// • BATTEMENT. Un ping toutes les 25 s : les connexions mortes (téléphone
//   passé en avion) sont fermées au lieu de s'accumuler.

final String _cleInterne = Platform.environment['CLE_INTERNE'] ?? '';
const _maxConnexionsParIp = 30;
const _maxMessagesParSeconde = 40;
const _tailleMaxMessage = 64 * 1024;
const _maxParBoite = 12;
final _connexionsParIp = <String, int>{};

/// Les verdicts récents de l'annuaire, pour ne pas le solliciter à chaque
/// reconnexion : identifiant|signature → (accepté, quand).
final _verdicts = <String, (({bool ok, String? compte}), DateTime)>{};

String _adresse(Request r) {
  final fwd = r.headers['x-forwarded-for'];
  if (fwd != null && fwd.isNotEmpty) return fwd.split(',').first.trim();
  final info = r.context['shelf.io.connection_info'];
  return info is HttpConnectionInfo ? info.remoteAddress.address : 'inconnu';
}

/// [peerId] a-t-il le droit d'entrer dans [roomId] ? L'annuaire tranche ;
/// s'il ne répond pas, on laisse passer (un appel vaut mieux qu'un refus
/// à tort) — sauf signature présente et invalide.
///
/// [compte] : un appareil lié (Droplet Web) dit parler au nom de ce compte.
/// L'annuaire le confirme (rendu dans `compte`) ou non (`null`).
Future<({bool ok, String? compte})> _identiteValide(String peerId, String roomId, Object? ts, Object? sig, Object? nonce, Object? compte) async {
  final cle = '$peerId|${sig ?? '-'}|${compte ?? '-'}';
  final deja = _verdicts[cle];
  if (deja != null && DateTime.now().difference(deja.$2) < const Duration(minutes: 2)) return deja.$1;
  try {
    final r = await _httpClient
        .post(
          Uri.parse('$_directoryUrl/interne/verifier'),
          headers: {'content-type': 'application/json', 'x-cle-interne': _cleInterne},
          body: jsonEncode({
            'peerId': peerId,
            'methode': 'GET',
            'chemin': '/ws/$roomId',
            'ts': ts,
            'sig': sig,
            'nonce': nonce,
            if (compte is String) 'compte': compte,
          }),
        )
        .timeout(const Duration(seconds: 5));
    if (r.statusCode != 200) return (ok: true, compte: null);
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    final verdict = (ok: j['ok'] == true, compte: j['compte'] as String?);
    _verdicts[cle] = (verdict, DateTime.now());
    if (_verdicts.length > 50000) _verdicts.clear();
    return verdict;
  } catch (_) {
    return (ok: sig == null, compte: null);
  }
}

// ── WebSocket Signaling ────────────────────────────────────────────

// ⚠️ CETTE SIGNATURE N'EST PAS UN DÉTAIL — LA ROUTE N'A JAMAIS MARCHÉ
// SANS ELLE.
//
// `shelf_router` appelle le gestionnaire d'une route avec LA REQUÊTE
// D'ABORD, PUIS chaque paramètre nommé dans le chemin (`<roomId>` ici) —
// donc `(Request request, String roomId)`, dans cet ordre précis. La
// version précédente était `Handler Function(String roomId)` : une
// USINE qui renvoie un gestionnaire, jamais un gestionnaire elle-même.
// `shelf_router` essayait de l'appeler directement avec `(request,
// roomId)`, ce qui ne correspondait à aucune des deux signatures
// possibles — ni « (Request) », ni « (Request, String) » — et levait un
// `NoSuchMethodError` avant même d'atteindre `webSocketHandler`. Chaque
// tentative de connexion échouait donc avec un 500 générique, côté
// client comme dans les journaux du serveur.
FutureOr<Response> _handleWebSocket(Request request, String roomId) {
  final ip = _adresse(request);
  if ((_connexionsParIp[ip] ?? 0) >= _maxConnexionsParIp) {
    return Response(429, body: 'trop de connexions');
  }
  if (roomId.length > 200) return Response(400);
  return webSocketHandler(pingInterval: const Duration(seconds: 25), (channel) {
    String? peerId;
    var autorises = <String>{};
    _connexionsParIp[ip] = (_connexionsParIp[ip] ?? 0) + 1;
    var fenetre = DateTime.now();
    var compte = 0;

    // Les messages sont traités UN PAR UN, dans l'ordre : la vérification
    // d'identité du `join` prend un aller-retour vers l'annuaire, et une
    // offre arrivée entre-temps ne doit pas passer devant.
    var file = Future<void>.value();
    Future<void> traiter(dynamic data) async {
        try {
          // Débit et taille : au-delà, la connexion est coupée.
          final maintenant = DateTime.now();
          if (maintenant.difference(fenetre) > const Duration(seconds: 1)) {
            fenetre = maintenant;
            compte = 0;
          }
          if (++compte > _maxMessagesParSeconde || (data is String && data.length > _tailleMaxMessage)) {
            channel.sink.close(1008, 'limite');
            return;
          }
          final msg = jsonDecode(data as String) as Map<String, dynamic>;
          final type = msg['type'] as String?;

          switch (type) {
            case 'join':
              final candidat = msg['peerId'] as String?;
              if (candidat == null || candidat.isEmpty || candidat.length > 128) return;
              final identite = await _identiteValide(candidat, roomId, msg['ts'], msg['sig'], msg['nonce'], msg['compte']);
              if (!identite.ok) {
                print('[Server] ⛔ Entrée refusée dans $roomId (identité non prouvée)');
                channel.sink.add(jsonEncode({'type': 'error', 'error': 'identite'}));
                channel.sink.close(1008, 'identite');
                return;
              }
              if (roomId.startsWith(_prefixeBoiteAppel) &&
                  (_rooms[roomId]?.peerCount ?? 0) >= _maxParBoite) {
                channel.sink.close(1008, 'salle pleine');
                return;
              }
              peerId = candidat;
              // Au nom de qui cette connexion peut parler : elle-même, et le
              // compte dont elle est l'appareil lié, si l'annuaire l'a confirmé.
              autorises = {candidat, if (identite.compte != null) identite.compte!};

              final room = _getOrCreateRoom(roomId);
              // ⚠️ LU AVANT D'AJOUTER CE PEER — sert à savoir si la
              // personne qu'on essaie de joindre était déjà là.
              final dejaPresents = room.peerIdsExcept(peerId);
              room.addPeer(peerId!, channel);

              print('[Server] $peerId a rejoint la salle $roomId '
                  '(${room.peerCount} peers)');

              channel.sink.add(jsonEncode({
                'type': 'joined',
                'roomId': roomId,
                'peerId': peerId,
                'peers': room.peerIdsExcept(peerId),
              }));

              // Quelqu'un rejoint la boîte d'appel personnelle DE
              // QUELQU'UN D'AUTRE (jamais la sienne — sinon on
              // « réveillerait » une personne du simple fait qu'elle
              // vient de se connecter elle-même), et cette personne
              // n'y était pas déjà : c'est un appel entrant que
              // personne n'écoute pour l'instant. Le bon moment pour
              // pousser une notification, plutôt que de laisser
              // l'offre WebRTC partir dans une salle vide.
              //
              // ⚠️ DEUX EXCEPTIONS, depuis que Droplet Web écoute aussi la
              // boîte du téléphone auquel il est lié :
              //   • un appareil qui vient ÉCOUTER (`ecoute: true`, Droplet
              //     Web) n'est pas un appel : il ne réveille personne ;
              //   • « personne n'écoute » veut dire « le téléphone n'est pas
              //     là », pas « la salle est vide » — sinon, le navigateur
              //     ouvert, le téléphone endormi n'était plus jamais réveillé.
              if (roomId.startsWith(_prefixeBoiteAppel) && msg['ecoute'] != true) {
                final destinataireId =
                    roomId.substring(_prefixeBoiteAppel.length);
                if (destinataireId != peerId && !dejaPresents.contains(destinataireId)) {
                  // Un Droplet Web appelle au nom de son compte : c'est ce
                  // compte que le téléphone réveillé doit voir appeler.
                  _reveillerParPush(destinataireId, appelantId: identite.compte ?? peerId!);
                }
              }

            case 'offer':
            case 'answer':
            case 'ice-candidate':
              // ⚠️ « DE LA PART DE » VÉRIFIÉ. Avant, le serveur relayait le
              // champ `from` tel quel : n'importe qui dans la salle pouvait
              // répondre à un appel au nom de l'appelé, et l'intercepter. Il
              // doit maintenant être l'identité prouvée à l'entrée (ou le
              // compte de l'appareil lié) — sinon, le message est jeté.
              final room = _rooms[roomId];
              if (peerId == null || room == null) return;
              if (!autorises.contains(msg['from'])) {
                print('[Server] ⛔ « from » usurpé dans $roomId : message jeté');
                return;
              }
              room.broadcast(peerId!, data as String);

            // « En train d'écrire… » pour quelqu'un joint par Internet.
            //
            // ⚠️ REMIS À SA BOÎTE D'APPEL SANS LA REJOINDRE. Rejoindre la
            // boîte de quelqu'un, c'est l'appeler : le serveur le réveillerait
            // par une notification d'appel. Ici on dépose seulement le signal
            // auprès de qui s'y trouve déjà ; personne n'y est (application
            // fermée) = le signal se perd, et c'est très bien : il ne vaut que
            // trois secondes.
            case 'frappe':
              final destinataire = msg['to'] as String?;
              if (peerId == null || destinataire == null || destinataire.isEmpty) return;
              _rooms['$_prefixeBoiteAppel$destinataire']?.broadcast(
                peerId!,
                jsonEncode({
                  'type': 'frappe',
                  'from': peerId,
                  if (msg['g'] is String) 'g': msg['g'],
                }),
              );

            case 'leave':
              _removePeerFromRoom(roomId, peerId);

            default:
              print('[Server] Message inconnu: $type');
          }
        } catch (e) {
          print('[Server] Erreur parsing: $e');
        }
    }

    channel.stream.listen(
      (data) => file = file.then((_) => traiter(data)),
      onDone: () {
        _removePeerFromRoom(roomId, peerId);
        final n = (_connexionsParIp[ip] ?? 1) - 1;
        if (n <= 0) {
          _connexionsParIp.remove(ip);
        } else {
          _connexionsParIp[ip] = n;
        }
      },
    );
  })(request);
}

void _removePeerFromRoom(String roomId, String? peerId) {
  if (peerId == null) return;
  final room = _rooms[roomId];
  if (room == null) return;

  room.removePeer(peerId);
  print('[Server] $peerId a quitté la salle $roomId (${room.peerCount} peers)');

  if (room.peerCount == 0) {
    _rooms.remove(roomId);
    print('[Server] Salle $roomId supprimée (vide)');
  }
}

// ── Utilitaires ────────────────────────────────────────────────────


// ── Main ───────────────────────────────────────────────────────────

void main(List<String> args) {
  final parser = ArgParser()
    ..addOption('port', abbr: 'p', help: 'Port d\'écoute')
    ..addOption('host', abbr: 'h', help: 'Adresse d\'écoute');

  final results = parser.parse(args);

  // Railway fournit le port via la variable d'environnement PORT.
  final portEnv = Platform.environment['PORT'];
  final port = int.parse(results['port'] as String? ?? portEnv ?? '8082');
  final host = results['host'] as String? ?? '0.0.0.0';

  io.serve(_dispatch, host, port).then((server) {
    print('[Server] DropletServer démarré sur http://${server.address.host}:${server.port}');
    print('[Server] Endpoints:');
    print('  GET  /health           — Health check');
    print('  WS   /ws/:roomId      — WebSocket signaling');
    print('  POST /turn/credentials — Credentials TURN');
  });
}
