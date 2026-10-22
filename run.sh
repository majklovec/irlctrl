# client
sudo REMOTE_TOKEN=token ENCODER_BIN=./ceracoder SRTLA_SEND_BIN=./srtla_send bun backend/client/client.ts --port 8085 --remote ws://127.0.0.1:8090/device --role encoder --pipelines ./pipeline/
# client
sudo REMOTE_TOKEN=token ENCODER_BIN=./ceracoder SRTLA_SEND_BIN=./srtla_send bun backend/client/client.ts --port 8086 --remote ws://127.0.0.1:8090/device --role relay --pipelines ./pipeline/
# server
bun backend/server/server.ts --device-token token --ui-user majkl --ui-password heslo
