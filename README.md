# Home Lab

Infrastructure-as-code for a Synology-powered homelab. The setup is split into two layers:

- **Terraform** manages Cloudflare infrastructure (tunnel, DNS records, ingress routing)
- **Docker Compose** manages all containerized services on the NAS

## Repository Layout

```
├── cloudflare.tf          # Tunnel, ingress config
├── homeassistant.tf       # HA DNS record + ingress
├── n8n.tf                 # n8n DNS record + ingress
├── rfid-analyzer.tf       # RFID analyzer DNS record + ingress
├── belegtools.tf          # Belegtools DNS record + ingress
├── providers.tf           # Cloudflare provider
├── variables.tf           # Input variables
├── locals.tf              # Shared Cloudflare identifiers
├── ha/                    # Home Assistant /config (gitignored, lives only on NAS)
└── docker/
    └── my-apps/
        ├── .env.example   # Required compose env vars (copy to .env, fill in)
        └── docker-compose.yml
```

## Services

All services run from a single compose project named `my-apps`.

| Service (container) | Image | Port | Subdomain |
|---|---|---|---|
| `homeassistant` | ghcr.io/home-assistant/home-assistant:stable | 8123 (host net) | `ha` |
| `n8n` | docker.n8n.io/n8nio/n8n:latest | 5678 (host net) | `n8n` |
| `cloudflared` | cloudflare/cloudflared:latest | — (host net) | — |
| `rfid-analyzer` | ghcr.io/martbent/rtl-sdr-uhf-rfid-analyzer:latest | 8080 → 80 | `sdr` |
| `belegtools` | ghcr.io/martbent/belegtools:latest | 3000 → 80 | `belegtools` (on belegtools.nl) |
| `belegtools-mongodb` | mongo:4.4 | internal | — |
| `belegtools-umami` | ghcr.io/umami-software/umami:postgresql-latest | 3001 → 3000 | — (local-network only) |
| `belegtools-umami-db` | postgres:16-alpine | internal | — |
| `watchtower` | containrrr/watchtower | — | — |

**Watchtower** runs in label-only mode — it only auto-updates containers with the `com.centurylinklabs.watchtower.enable=true` label (currently `rfid-analyzer`, `belegtools`, `watchtower` itself). Third-party images (HA, n8n, postgres, mongo, cloudflared) are updated manually.

## Requirements

- **Synology DSM** with the Docker/Container Manager package installed
- **Terraform >= 1.5**, executed via the official Docker image
- **Cloudflare API token** with:
  - Account: Zero Trust Tunnel (Read & Edit)
  - Zone: DNS (Read & Edit)

## Setup

The full bring-up is **Terraform first → grab tunnel token → docker compose up**, because the `CLOUDFLARE_TUNNEL_TOKEN` is an output of `terraform apply`.

### 1. Terraform

Add a helper function so every command runs inside the official Docker image:

```bash
terraform() {
  docker run --rm \
    --env-file "$PWD/.env" \
    -v "$PWD":/workspace \
    -w /workspace \
    hashicorp/terraform:latest "$@"
}
```

Create `.env` in the repo root (gitignored):

```bash
TF_VAR_cloudflare_api_token=<your token>
TF_VAR_cloudflare_domain_name=example.com
TF_VAR_cloudflare_tunnel_name=HomeLab
TF_VAR_host_local_ip=server.home          # hostname or IP the cloudflared container resolves
TF_VAR_homeassistant_prefix=ha
TF_VAR_n8n_prefix=n8n
TF_VAR_rfid_analyzer_prefix=sdr
TF_VAR_belegtools_domain_name=belegtools.nl
```

Apply:

```bash
terraform init
terraform apply -auto-approve
```

### 2. Grab the tunnel token

```bash
terraform output -raw cloudflare_tunnel_token
```

### 3. Docker Compose env file

```bash
cp docker/my-apps/.env.example docker/my-apps/.env
chmod 600 docker/my-apps/.env
# Paste the tunnel token from step 2 into CLOUDFLARE_TUNNEL_TOKEN
# Fill in MONGO_*, UMAMI_*, APP_*, N8N_* values
```

This single file holds all compose-time vars. It's auto-loaded by `docker compose` because it sits next to `docker-compose.yml`.

### 4. Home Assistant config

The `ha/` directory is gitignored — it holds HA's runtime config + DB + backups. On a fresh setup, create it with at least:

```yaml
# ha/configuration.yaml
default_config:

http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 192.168.0.0/24    # LAN subnet — cloudflared (host net) appears from the NAS IP here
    - 127.0.0.1
```

The `trusted_proxies` block is required because cloudflared runs in `network_mode: host` and reaches HA at `http://server.home:8123`; from HA's perspective the X-Forwarded-For comes from the host's LAN IP. Without it HA returns `400 Bad Request` on all proxied requests.

### 5. Docker Compose up

```bash
DOCKER=/usr/local/bin/docker
$DOCKER compose -f docker/my-apps/docker-compose.yml up -d
```

### 6. GHCR authentication (for private images)

```bash
docker login ghcr.io -u <github-username>
```

Enter a Personal Access Token with `read:packages` scope.

## Token rotation

If you rotate the Cloudflare API token (or run `terraform destroy` + `apply` and need a new tunnel token):

```bash
# In repo root
terraform apply -auto-approve
NEW_TOKEN=$(terraform output -raw cloudflare_tunnel_token)
sed -i.bak -E "s|^CLOUDFLARE_TUNNEL_TOKEN=.*|CLOUDFLARE_TUNNEL_TOKEN=$NEW_TOKEN|" docker/my-apps/.env
rm docker/my-apps/.env.bak
docker compose -f docker/my-apps/docker-compose.yml up -d --force-recreate cloudflared
```
