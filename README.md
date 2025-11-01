# Home Lab

Infrastructure-as-code for a small homelab, managed entirely with Terraform. It provisions:
- Cloudflare Zero Trust Tunnel and DNS
- Host-networked Docker containers for services (Home Assistant, n8n)
- A modular ingress configuration to route tunnel traffic to local services

## Prerequisites
- Terraform >= 1.5
- Cloudflare API token with permissions:
  - Account: Zero Trust Tunnel: Read & Edit
  - Zone: DNS: Read & Edit

## Structure
- `providers.tf` – providers (Cloudflare, Docker)
- `variables.tf` – input variables
- `locals.tf` – shared Cloudflare IDs (account_id, zone_id, tunnel_id)
- `cloudflare.tf` – Cloudflare tunnel, config, output, Cloudflared container
- `homeassistant.tf` – Home Assistant DNS, ingress, Docker image/container
- `n8n.tf` – n8n DNS, ingress, Docker image/container
- `synology_drive.tf` – Synology Drive DNS

## Configuration
Create `terraform.tfvars` (example):
```hcl
cloudflare_api_token   = "<your token>"
cloudflare_domain_name = "example.com"
cloudflare_tunnel_name = "homelab-tunnel"
host_local_ip          = "192.168.1.10"

# Service subdomain prefixes
homeassistant_prefix = "ha"
n8n_prefix           = "n8n"
drive_prefix         = "drive"

# Local data paths for containers (required)
homeassistant_config_path = "/srv/homeassistant/config"
n8n_data_path              = "/srv/n8n/data"

# Optional: Docker host (default unix:///var/run/docker.sock)
# docker_host = "unix:///var/run/docker.sock"
```

Use terraform in docker since DSM makes it almost impossible to install CLI tools:

```bash
alias terraform="docker run 
  --rm 
  --env-file .env 
  -w /home 
  -v ./:/home 
  -v /var/run/docker.sock:/var/run/docker.sock 
  hashicorp/terraform:latest" 
```

Deploying the homelab:
```bash
terraform init 
terraform apply --auto-approve 
```

Shutting down the homelab:
```bash
terraform destoy --auto-approve 
```

## What gets created
- Cloudflare Tunnel and DNS CNAMEs for service subdomains.
- Ingress rules composed from each service file and applied to the tunnel:
```19:33:/Users/mart.bent/Private/Git/homelab/cloudflare.tf
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  tunnel_id  = local.tunnel_id
  account_id = local.account_id
  config = {
    ingress = concat(
      local.ingress_homeassistant,
      local.ingress_n8n,
      local.ingress_drive,
      [
        {
          service = "http_status:404"
        }
      ]
    )
  }
}
```
- Cloudflared connector running as a Docker container on the host:
```41:51:/Users/mart.bent/Private/Git/homelab/cloudflare.tf
resource "docker_container" "cloudflared" {
  image        = docker_image.cloudflared.name
  name         = "cloudflared"
  network_mode = "host"
  restart      = "unless-stopped"
  command      = ["tunnel", "run", "--token", data.cloudflare_zero_trust_tunnel_cloudflared_token.tunnel_token.token]
}
```
- Home Assistant container (host networking) using your local config path:
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
- n8n container (host networking) with persistent data volume and env:
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
