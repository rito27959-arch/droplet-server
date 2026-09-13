# ── DropletServer (Railway) ──────────────────────────────────────────
# Serveur de signaling WebRTC + TURN pour les appels audio/vidéo.
# Déployé sur Railway.app
# ─────────────────────────────────────────────────────────────────────

FROM dart:stable-sdk AS build

WORKDIR /app

COPY pubspec.yaml ./
RUN dart pub get

COPY . .

RUN dart compile exe lib/server.dart -o bin/server

# ── Image finale ────────────────────────────────────────────────────
FROM debian:bookworm-slim

# ⚠️ LES CERTIFICATS RACINE SONT INDISPENSABLES. Un binaire `dart compile
# exe` valide TLS avec le magasin du système ; `bookworm-slim` n'en contient
# aucun. Sans ce paquet, TOUTE requête HTTPS sortante échouait avec
# « CERTIFICATE_VERIFY_FAILED: unable to get local issuer certificate » —
# constaté dans les journaux Railway : aucun réveil par notification
# (nouveau message, appel entrant) n'a jamais pu partir, et l'annuaire
# n'aurait pas pu joindre Firebase.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/bin/server /app/server

ENV PORT=8082
EXPOSE 8082

ENTRYPOINT ["/app/server"]
