job "[[.DOMAIN]]" {

  datacenters = [[ .DATACENTERS  | toJson ]]
  type        = "service"

  # ============================================================
  # Group 1 — the existing irlctrl-server (unchanged)
  # ============================================================
  group "[[.SERVICE_ID]]" {
    count = 1

    restart {
      attempts = 5
      delay    = "30s"
    }

    network {
      port "http" { to = 8090 }
    }

    task "[[.SERVICE_ID]]" {
      driver = "docker"
      user   = "1000:1000"

      config {
        image = "ghcr.io/majklovec/irlctrl-server"
        ports = ["http"]
        mount {
          type     = "bind"
          target   = "/config"
          source   = "/data/[[.SERVICE_ID]]/db"
          readonly = false
        }
        mount {
          type     = "bind"
          target   = "/assets"
          source   = "/data/[[.SERVICE_ID]]/assets"
          readonly = false
        }
      }

      env {
        DB_FILE     = "/config/db.sqlite"
        STORAGE_DIR = "/assets"
      }

      resources {
        cpu    = 200
        memory = 256
      }

      service {
        provider = "nomad"
        port     = "http"
        name     = "[[.SERVICE_ID]]"

        tags = [
          "traefik.enable=true",
          "traefik.http.routers.[[.SERVICE_ID]].rule=Host(`[[.DOMAIN]]`)"
        ]

        check {
          type     = "http"
          path     = "/healthz"
          interval = "15s"
          timeout  = "5s"

          check_restart {
            limit = 5
            grace = "30s"
          }
        }
      }
    }
  }

  # ============================================================
  # Group 2 — coturn TURN server (new)
  #
  # Why a separate group? A Nomad group shares ONE network mode,
  # and coturn must use HOST networking so it can bind the full UDP
  # relay range (49152-65535) directly — Docker's userland proxy
  # cannot port-map that range efficiently.
  #
  # Node requirements:
  #   - A public IP reachable by WebRTC clients.
  #   - Inbound firewall rules (host + any cloud security group):
  #       TCP 3478         TURN / STUN
  #       UDP 3478         TURN / STUN
  #       UDP 49152-65535  media relay range
  #     (Also open TCP/UDP 5349 if you enable TURN-over-TLS below.)
  #
  # If your cluster has dedicated edge nodes, uncomment the
  # constraint to pin this group:
  #   constraint {
  #     attribute = "${node.class}"
  #     value     = "edge"
  #   }
  # ============================================================
  group "[[.SERVICE_ID]]-turn" {
    count = 1

    restart {
      attempts = 5
      delay    = "30s"
    }

    network {
      mode = "host"
    }

    task "coturn" {
      driver = "docker"

      config {
        image        = "coturn/coturn:4.6.2"
        network_mode = "host"
        # The config file is rendered by the `template` stanza below;
        # point coturn at it explicitly.
        args = ["-c", "local/turnserver.conf"]

        # Enable TURN-over-TLS (turns:) by uncommenting this mount AND
        # the matching tls-* lines in the template. Requires real,
        # client-trusted certs (e.g. Let's Encrypt) — self-signed
        # certificates are rejected by browsers.
        #
        # mount {
        #   type     = "bind"
        #   target   = "/etc/coturn/certs"
        #   source   = "/data/[[.SERVICE_ID]]-turn/certs"
        #   readonly = true
        # }
      }

      template {
        destination = "local/turnserver.conf"
        data        = <<EOF
listening-port=3478
min-port=49152
max-port=65535
realm=turn.[[.DOMAIN]]

# Shared-secret authentication (recommended): the signaling server
# mints time-limited credentials as
#   username   = <unix-timestamp + ttl>
#   credential = base64(HMAC-SHA1(TURN_SECRET, username))
# If you'd rather hardcode static users, replace these two lines with:
#   lt-cred-mech
#   user=webrtc:<password>
use-auth-secret
static-auth-secret=[[.TURN_SECRET]]

fingerprint
no-cli
no-multicast-peers
log-file=stdout

# --- TURN over TLS (optional) ---
# Uncomment together with the certs mount above:
# tls-listening-port=5349
# cert=/etc/coturn/certs/fullchain.pem
# pkey=/etc/coturn/certs/privkey.pem
EOF
      }

      env {
        # Let coturn discover the host's public IP for ICE relay.
        # If the node sits behind a 1:1 NAT where the container's
        # address differs from the public address, replace these with
        # an explicit arg instead:
        #   args = ["-c", "${NOMAD_TASK_DIR}/turnserver.conf",
        #           "--external-ip=<PUBLIC_IP>"]
        DETECT_EXTERNAL_IP = "yes"
        DETECT_RELAY_IP    = "yes"
      }

      resources {
        # TURN is bandwidth-bound, not CPU-bound; start small and
        # scale the node (or add replicas on separate nodes) if needed.
        cpu    = 200
        memory = 256
      }
    }
  }
}