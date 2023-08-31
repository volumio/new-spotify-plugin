#!/bin/sh

git clone  https://github.com/devgianlu/go-librespot.git
cd go-librespot

echo 'log_level: trace
device_name: "go-librespot test"
auth_method: "zeroconf"
server_port: 9876
audio_device: "volumio"' > config.yml


echo "#!/bin/sh
/usr/local/go/bin/go run ./cmd/daemon -config_path /tmp/go-librespot-config.yml -credentials_path /data/configuration/music_service/spop/spotifycredentials.json" > run.sh
chmod a+x run.sh
