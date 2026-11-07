job "[[.DOMAIN]]" {

  datacenters = [[ .DATACENTERS  | toJson ]]
  type        = "service"

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
        image = "majkl/irlctrl-control:latest"
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
        DB_FILE     = "/config/users.db"
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
}
