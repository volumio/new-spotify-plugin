#!/bin/sh

git clone  https://github.com/devgianlu/go-librespot.git
cd go-librespot

echo 'log_level: trace
device_name: "go-librespot test"
auth_method: "zeroconf"
server_port: 9876
audio_device: "volumio"' > config.yml


echo "go run ./cmd/daemon" > run.sh
chmod a+x run.sh
