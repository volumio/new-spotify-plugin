#!/bin/sh


DIST=$(cat /etc/os-release | grep ^VERSION_ID | tr -d 'VERSION_ID="')
ARCH=$(cat /etc/os-release | grep ^VOLUMIO_ARCH | tr -d 'VOLUMIO_ARCH="')
VARIANT=$(cat /etc/os-release | grep ^VOLUMIO_VARIANT | tr -d 'VOLUMIO_VARIANT="')
HARDWARE=$(cat /etc/os-release | grep ^VOLUMIO_HARDWARE | tr -d 'VOLUMIO_HARDWARE="')

echo "Installing dependencies"
sudo apt-get update
sudo apt-get install -y libasound2-dev build-essential

echo "Downloading GO"

if [ "$ARCH" = "arm" ] || [ "$ARCH" = "armv7" ] ;then
  echo "Getting go for armhf"
  wget https://go.dev/dl/go1.20.6.linux-armv6l.tar.gz
  tar -C /usr/local -xzf go1.20.6.linux-armv6l.tar.gz
  rm go1.20.6.linux-armv6l.tar.gz
else
  echo "Getting go for x64"
  wget https://go.dev/dl/go1.20.6.linux-amd64.tar.gz
  tar -C /usr/local -xzf go1.20.6.linux-amd64.tar.gz
  rm go1.20.6.linux-amd64.tar.gz
fi

echo "Setting paths"
PATH=$PATH:/usr/local/go/bin

echo "Done"
