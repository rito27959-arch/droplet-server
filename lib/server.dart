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

Future<Response> _handleTurnCredentials(Request request) async {
  try {
    final body = await request.readAsString();
    final json = jsonDecode(body) as Map<String, dynamic>?;
    final peerId = json?['peerId'] as String? ?? 'unknown';

    final timestamp = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    final secret = 'droplet-turn-secret'; // En prod: variable d'env

    final credential = _hmac('$peerId:$timestamp:$secret');

    return Response.ok(
      jsonEncode({
        'urls': [
          'turn:turn.droplet.app:3478?transport=udp',
          'turn:turn.droplet.app:3478?transport=tcp',
        ],
        'username': '$timestamp:${_hmac("$peerId:$secret")}',
        'credential': credential,
        'ttl': 86400,
      }),
      headers: {'content-type': 'application/json'},
    );
  } catch (e) {
    return Response(500, body: jsonEncode({'error': e.toString()}));
  }
}

// ── WebSocket Signaling ────────────────────────────────────────────

Handler _handleWebSocket(String roomId) {
  return webSocketHandler((channel) {
    String? peerId;

    channel.stream.listen(
      (data) {
        try {
          final msg = jsonDecode(data as String) as Map<String, dynamic>;
          final type = msg['type'] as String?;

          switch (type) {
            case 'join':
              peerId = msg['peerId'] as String?;
              if (peerId == null) return;

              final room = _getOrCreateRoom(roomId);
              room.addPeer(peerId!, channel);

              print('[Server] $peerId a rejoint la salle $roomId '
                  '(${room.peerCount} peers)');

              channel.sink.add(jsonEncode({
                'type': 'joined',
                'roomId': roomId,
                'peerId': peerId,
                'peers': room.peerIdsExcept(peerId),
              }));

            case 'offer':
            case 'answer':
            case 'ice-candidate':
              final room = _rooms[roomId];
              if (peerId != null && room != null) {
                room.broadcast(peerId!, data as String);
              }

            case 'leave':
              _removePeerFromRoom(roomId, peerId);

            default:
              print('[Server] Message inconnu: $type');
          }
        } catch (e) {
          print('[Server] Erreur parsing: $e');
        }
      },
      onDone: () {
        _removePeerFromRoom(roomId, peerId);
      },
    );
  });
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

String _hmac(String data) {
  var hash = 0;
  for (var i = 0; i < data.length; i++) {
    hash = ((hash << 5) + hash + data.codeUnitAt(i)) & 0xFFFFFFFF;
  }
  return hash.toRadixString(16);
}

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

  final handler = const Pipeline()
      .addMiddleware(logRequests())
      .addHandler(_router.call);

  io.serve(handler, host, port).then((server) {
    print('[Server] DropletServer démarré sur http://${server.address.host}:${server.port}');
    print('[Server] Endpoints:');
    print('  GET  /health           — Health check');
    print('  WS   /ws/:roomId      — WebSocket signaling');
    print('  POST /turn/credentials — Credentials TURN');
  });
}
