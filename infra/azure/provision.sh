#!/usr/bin/env bash
# Create the DeployForge server on Azure: one Ubuntu VM with a static public
# IP, ports 80 and 443 open, and Docker installed on first boot.
#
#   az login
#   infra/azure/provision.sh
#
# Override any of the settings below from the environment, e.g.
#   LOCATION=southindia VM_SIZE=Standard_B2ms infra/azure/provision.sh
#
# Azure for Students subscriptions only allow some regions and sizes. If
# creation fails with "RequestDisallowedByPolicy" or "SkuNotAvailable", try
# another LOCATION.
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-deployforge-rg}"
LOCATION="${LOCATION:-centralindia}"
VM_NAME="${VM_NAME:-deployforge-vm}"
# 2 vCPU / 4 GB. Enough for the platform plus a handful of student apps once
# builds move to GitHub Actions.
VM_SIZE="${VM_SIZE:-Standard_B2s}"
ADMIN_USER="${ADMIN_USER:-azureuser}"
DISK_GB="${DISK_GB:-64}"

here="$(cd "$(dirname "$0")" && pwd)"
cloud_init="$here/cloud-init.yaml"
# The Windows build of az cannot read a Git Bash path like /c/Users/...
command -v cygpath >/dev/null && cloud_init="$(cygpath -w "$cloud_init")"

command -v az >/dev/null || {
  echo "Azure CLI not found. Install it with: winget install Microsoft.AzureCLI" >&2
  exit 1
}
az account show >/dev/null 2>&1 || {
  echo "Not logged in. Run: az login" >&2
  exit 1
}

echo "Subscription: $(az account show --query name -o tsv)"
echo "Creating $VM_NAME ($VM_SIZE) in $LOCATION ..."

az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

az vm create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --image Ubuntu2404 \
  --size "$VM_SIZE" \
  --admin-username "$ADMIN_USER" \
  --generate-ssh-keys \
  --public-ip-sku Standard \
  --public-ip-address-allocation static \
  --os-disk-size-gb "$DISK_GB" \
  --custom-data "$cloud_init" \
  --output none

# SSH (22) is opened by `vm create`. The router needs 80 for HTTP and the
# Let's Encrypt challenge, and 443 for everything else.
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" \
  --port 80 --priority 1010 --output none
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" \
  --port 443 --priority 1020 --output none

ip="$(az vm show --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" \
  --show-details --query publicIps -o tsv | tr -d '\r')"
domain="${ip//./-}.sslip.io"

cat <<EOF

Server ready at $ip (Docker is still installing for a minute or two).

  Console  https://console.$domain
  API      https://api.$domain
  Apps     https://<app>.$domain

Next:
  1. Create a GitHub OAuth App with callback URL
       https://api.$domain/github/callback
  2. Deploy:
       infra/deploy.sh $ip
EOF
