#!/usr/bin/env bash
# Ship the committed code to the server and (re)start the platform.
#
#   infra/deploy.sh <server-ip>
#
# What is deployed is HEAD, not the working tree: uncommitted edits stay on
# your machine, so what runs on the server is always something in git.
#
# On the first run it writes the server's .env, generating every secret and
# asking only for what it cannot invent (the GitHub OAuth App, an email for
# Let's Encrypt). Later runs keep that file untouched: replacing
# TOKEN_ENCRYPTION_KEY would make every stored token unreadable.
set -euo pipefail

ip="${1:?usage: infra/deploy.sh <server-ip>}"
user="${ADMIN_USER:-azureuser}"
remote="$user@$ip"
base=/opt/deployforge

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Note: uncommitted changes are NOT deployed; deploying $(git rev-parse --short HEAD)." >&2
fi

ssh_() { ssh -o StrictHostKeyChecking=accept-new "$remote" "$@"; }

echo "Waiting for first-boot setup on $ip ..."
until ssh_ "test -f $base/.provisioned && docker info >/dev/null 2>&1"; do
  sleep 10
done

if ! ssh_ "test -f $base/.env"; then
  echo "First deploy: writing $base/.env on the server."
  domain="${DOMAIN:-${ip//./-}.sslip.io}"
  read -rp "Email for Let's Encrypt: " acme_email
  echo "GitHub OAuth App callback URL must be: https://api.$domain/github/callback"
  read -rp "GitHub OAuth client ID: " gh_id
  read -rsp "GitHub OAuth client secret: " gh_secret
  echo

  # Secrets are generated on the server, so they never exist on this machine.
  ssh_ "umask 077 && cat > $base/.env" <<EOF
DOMAIN=$domain
ACME_EMAIL=$acme_email
GITHUB_CLIENT_ID=$gh_id
GITHUB_CLIENT_SECRET=$gh_secret
EOF
  ssh_ "cd $base && {
    echo POSTGRES_PASSWORD=\$(openssl rand -hex 24)
    echo JWT_SECRET=\$(openssl rand -hex 32)
    echo TRAEFIK_PROVIDER_TOKEN=\$(openssl rand -hex 24)
    echo TOKEN_ENCRYPTION_KEY=\$(python3 -c 'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')
  } >> .env"
fi

echo "Uploading $(git rev-parse --short HEAD) ..."
# A fresh directory each time, so a file deleted from the repo is deleted from
# the server too.
git archive --format=tar HEAD | ssh_ "rm -rf $base/src.new && mkdir -p $base/src.new \
  && tar -x -C $base/src.new && rm -rf $base/src && mv $base/src.new $base/src"

echo "Building and starting ..."
ssh_ "cd $base/src && docker compose --env-file $base/.env up -d --build --remove-orphans \
  && docker image prune -f >/dev/null"

domain="$(ssh_ "grep '^DOMAIN=' $base/.env | cut -d= -f2")"
cat <<EOF

Deployed. The first HTTPS request to each host takes a few seconds while
Let's Encrypt issues its certificate.

  Console  https://console.$domain
  API      https://api.$domain/health

Create the administrator (once):
  ssh -t $remote "cd $base/src && docker compose --env-file $base/.env exec backend python -m scripts.create_admin you@example.com"
EOF
