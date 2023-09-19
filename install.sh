#!/bin/bash

echo "Installing Go-librespot"

ARCH=$(cat /etc/os-release | grep ^VOLUMIO_ARCH | tr -d 'VOLUMIO_ARCH="')

DAEMON_BASE_URL=https://repo.volumio.org/Packages/go-librespot-daemon/go-librespot-daemon
DAEMON_DOWNLOAD_URL=$DAEMON_BASE_URL-$ARCH

# TODO DOWNLOAD FROM RELEASES URL
echo "Dowloading daemon"
wget $DAEMON_DOWNLOAD_URL -O /usr/bin/go-librespot-daemon
chmod a+x /usr/bin//go-librespot-daemon

echo "[Unit]
Description = go-librespot Daemon
After = volumio.service

[Service]
ExecStart=/usr/bin/go-librespot-daemon -config_path /tmp/go-librespot-config.yml -credentials_path /data/configuration/music_service/spop/spotifycredentials.json
Restart=always
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=go-librespot
User=volumio
Group=volumio
[Install]
WantedBy=multi-user.target" > /lib/systemd/system/go-librespot-daemon.service

#required to end the plugin install
echo "plugininstallend"
