#!/bin/bash

echo "Installing Go-librespot"

ARCH=$(cat /etc/os-release | grep ^VOLUMIO_ARCH | tr -d 'VOLUMIO_ARCH="')

echo "Copying appropriate Go-librespot Daemon"
#cp ${DESTPATH}/bin/${ARCH}/streaming-daemon /bin/streaming-daemon
#cp ${DESTPATH}/bin/${ARCH}/version_hash ${DESTPATH}/version_hash
#chmod a+x /bin/streaming-daemon

## TODO: Finish with compiled daemon

echo "[Unit]
Description = go-librespot Daemon
After = volumio.service

[Service]
#ExecStart=/bin/streaming-daemon
WorkingDirectory=/home/volumio/new-spotify-plugin/librespot-go/go-librespot
ExecStart=/home/volumio/new-spotify-plugin/librespot-go/go-librespot/run.sh
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
