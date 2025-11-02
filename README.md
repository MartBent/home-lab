# Home Lab

Infrastructure-as-code for a Synology-powered homelab, managed entirely with Terraform executed inside Docker. The configuration provisions:

- Cloudflare Zero Trust tunnel and DNS records for remote access
- Host-networked Docker containers for Home Assistant and n8n
- Modular ingress rules that route Cloudflare traffic back to services on your LAN

## Requirements

- **Synology DSM** with the Docker package installed
- **Terraform >= 1.5**, executed via the official Docker image
- **Cloudflare API token** with:
  - Account: Zero Trust Tunnel (Read & Edit)
  - Zone: DNS (Read & Edit)

## Repository Layout

- `providers.tf` – Cloudflare and Docker providers
- `variables.tf` – Input variables for tokens, prefixes, and host paths
- `locals.tf` – Shared Cloudflare identifiers (account, zone, tunnel)
- `cloudflare.tf` – Tunnel resources, ingress config, and Cloudflared container
- `homeassistant.tf` – DNS, ingress, and container for Home Assistant
- `n8n.tf` – DNS, ingress, and container for n8n
- `run.sh` – Convenience wrapper that calls Terraform commands

## Configure Terraform in Docker on Synology DSM

1. Grant your DSM user access to Docker:

   ```bash
   sudo synogroup -add docker "$USER"
   sudo chown root:docker /var/run/docker.sock
   ```

   Log out and back in (or reboot) so the new group membership takes effect.

2. Add a Terraform helper function so every Terraform command runs inside the official Docker image (add this to your shell profile, e.g. `~/.zshrc`):

   ```bash
   terraform() {
     docker run --rm \
       --env-file "$PWD/.env" \
       -v "$PWD":/workspace \
       -v /var/run/docker.sock:/var/run/docker.sock \
       -w /workspace \
       hashicorp/terraform:latest "$@"
   }
   ```
## Configuration

Populate a `.env` file in the repository root with Terraform variables. Terraform automatically maps any variable prefixed with `TF_VAR_` to the corresponding input variable in your configuration:

```bash
TF_VAR_cloudflare_api_token=<your token>
TF_VAR_cloudflare_domain_name=example.com
TF_VAR_cloudflare_tunnel_name=homelab-tunnel
TF_VAR_host_local_ip=192.168.1.10

# Service subdomain prefixes
TF_VAR_homeassistant_prefix=ha
TF_VAR_n8n_prefix=n8n

# Local data paths for containers (required)
TF_VAR_homeassistant_config_path=/srv/homeassistant/config
TF_VAR_n8n_data_path=/srv/n8n/data

# Optional: override the Docker socket location
# TF_VAR_docker_host=unix:///var/run/docker.sock
```

## Usage

Run Terraform commands as usual—the wrapper forwards arguments to the Dockerised CLI:

```bash
terraform init
terraform plan
terraform apply --auto-approve
```

To tear everything down:

```bash
terraform destroy --auto-approve
```
## What Gets Created

- Cloudflare tunnel, tunnel token output, and dockerised Cloudflared connector defined in `cloudflare.tf`.
- DNS CNAMEs and ingress definitions for each service file (`homeassistant.tf`, `n8n.tf`).
- Host-networked Docker containers that reuse existing data directories on the Synology box.

Terraform combines the ingress arrays exposed by each service into the tunnel configuration:

```19:33:/Users/mart.bent/Private/Git/homelab/cloudflare.tf
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  tunnel_id  = local.tunnel_id
  account_id = local.account_id
  config = {
    ingress = concat(
      local.ingress_homeassistant,
      local.ingress_n8n,
      [
        {
          service = "http_status:404"
        }
      ]
    )
  }
}
```

The Cloudflared connector runs alongside your other services on the Synology host:

```41:50:/Users/mart.bent/Private/Git/homelab/cloudflare.tf
resource "docker_container" "cloudflared" {
  image        = docker_image.cloudflared.name
  name         = "cloudflared"
  network_mode = "host"
  restart      = "unless-stopped"
  command      = ["tunnel", "run", "--token", data.cloudflare_zero_trust_tunnel_cloudflared_token.tunnel_token.token]
}
```

Service containers reuse host paths you define via the `TF_VAR_*` values in `.env`, keeping configuration and data persistent across redeployments:

```25:36:/Users/mart.bent/Private/Git/homelab/homeassistant.tf
resource "docker_container" "homeassistant" {
  image        = docker_image.homeassistant.name
  name         = "homeassistant"
  network_mode = "host"
  restart      = "unless-stopped"
  volumes {
    container_path = "/config"
    host_path      = var.homeassistant_config_path
    read_only      = false
  }
}
```

```25:46:/Users/mart.bent/Private/Git/homelab/n8n.tf
resource "docker_container" "n8n" {
  image        = docker_image.n8n.name
  name         = "n8n"
  network_mode = "host"
  restart      = "unless-stopped"
  volumes {
    container_path = "/home/node/.n8n"
    host_path      = var.n8n_data_path
    read_only      = false
  }
  env = [
    "NODE_ENV=production",
    "N8N_RELEASE_TYPE=stable",
    "GENERIC_TIMEZONE=Europe/Amsterdam",
    "TZ=Europe/Amsterdam",
    "SUBDOMAIN=${var.n8n_prefix}",
    "N8N_HOST=${var.n8n_prefix}.${var.cloudflare_domain_name}",
    "DOMAIN_NAME=${var.cloudflare_domain_name}",
    "WEBHOOK_URL=https://${var.n8n_prefix}.${var.cloudflare_domain_name}"
  ]
}
```
