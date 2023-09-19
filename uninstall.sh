#!/bin/bash

echo "Unistalling go-librespot-daemon"

rm /usr/bin/go-librespot-daemon
rm /lib/systemd/system/go-librespot-daemon.service

echo "Done"
echo "pluginuninstallend"
