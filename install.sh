#!/bin/bash

echo "Installing Go-librespot"

ARCH=$(cat /etc/os-release | grep ^VOLUMIO_ARCH | tr -d 'VOLUMIO_ARCH="')

if [ $ARCH = "armv7" ] || [ $ARCH = "armv6" ] || [ $ARCH = "armhf" ] || [ $ARCH = "arm" ]; then
	ARCH="armv6"
elif  [ $ARCH = "amd64" ] || [ $ARCH = "x86_64" ] || [ $ARCH = "x64" ]; then
	ARCH="x86_64"
elif  [ $ARCH = "i386" ] || [ $ARCH = "i686" ] || [ $ARCH = "x86" ]; then
	echo "Platform not supported" 
        exit 1
fi

DAEMON_BASE_URL=https://github.com/devgianlu/go-librespot/releases/download/v
VERSION=0.0.2
DAEMON_ARCHIVE=go-librespot_linux_$ARCH.tar.gz
DAEMON_DOWNLOAD_URL=$DAEMON_BASE_URL$VERSION/$DAEMON_ARCHIVE
DAEMON_DOWNLOAD_PATH=/home/volumio/$DAEMON_ARCHIVE

echo "Dowloading daemon"
wget $DAEMON_DOWNLOAD_URL -O $DAEMON_DOWNLOAD_PATH
tar xf $DAEMON_DOWNLOAD_PATH -C /usr/bin/
rm $DAEMON_DOWNLOAD_PATH
chmod a+x /usr/bin/go-librespot

echo "Creating data path"
mkdir /data/go-librespot/
chown -R volumio:volumio /data/go-librespot/

echo "[Unit]
Description = go-librespot Daemon
After = volumio.service

[Service]
ExecStart=/usr/bin/go-librespot -config_path /tmp/go-librespot-config.yml -credentials_path /data/configuration/music_service/spop/spotifycredentials.json
WorkingDirectory=/data/go-librespot/
Restart=always
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=go-librespot
User=volumio
Group=volumio
Environment=GOTRACEBACK=crash
[Install]
WantedBy=multi-user.target" > /lib/systemd/system/go-librespot-daemon.service

#required to end the plugin install
echo "plugininstallend"
