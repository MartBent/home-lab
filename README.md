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

### 1. Environment variables

Copy the compose env example and fill in values:

```bash
cp docker/my-apps/.env.example docker/my-apps/.env
chmod 600 docker/my-apps/.env
```

This single file holds all compose-time vars (belegtools DB credentials, Umami secrets, Cloudflare tunnel token, n8n config). It's auto-loaded by `docker compose` because it sits next to `docker-compose.yml`.

### 2. Docker Compose

Start all apps on the NAS:

```bash
DOCKER=/usr/local/bin/docker
$DOCKER compose -f docker/my-apps/docker-compose.yml up -d
```

### 3. Terraform

Add a Terraform helper function so every command runs inside the official Docker image:

```bash
terraform() {
  docker run --rm \
    --env-file "$PWD/.env" \
    -v "$PWD":/workspace \
    -w /workspace \
    hashicorp/terraform:latest "$@"
}
```

Configure Terraform variables in a `.env` file in the repo root:

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

Then run:

```bash
terraform init
terraform plan
terraform apply --auto-approve
```

### 4. GHCR authentication

To pull private images from GitHub Container Registry:

```bash
docker login ghcr.io -u <github-username>
```

Enter a Personal Access Token with `read:packages` scope.
