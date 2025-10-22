# HomeLab (Terraform only)

Infrastructure-as-code for a small homelab, managed entirely with Terraform. It provisions:
- Cloudflare Zero Trust Tunnel
- DNS CNAME records for service subdomains
- A modular ingress configuration for routing tunnel traffic to local services

## Prerequisites
- Terraform >= 1.5
- Cloudflare API token with permissions:
  - Account: Zero Trust Tunnel: Read & Edit
  - Zone: DNS: Read & Edit

## Repository structure
- `infra/` – Terraform for Cloudflare (providers, variables, tunnel, DNS)
  - `main.tf` – tunnel, config, outputs
  - `homeassistant.tf`, `n8n.tf`, `synology_drive.tf` – per‑service DNS + ingress
  - `providers.tf`, `variables.tf`, `locals.tf` – providers, inputs, and shared IDs

## Usage
Create `infra/terraform.tfvars` (example):
```hcl
cloudflare_api_token   = "<your token>"
cloudflare_domain_name = "example.com"
cloudflare_tunnel_name = "homelab-tunnel"
host_local_ip          = "192.168.1.10"
homeassistant_prefix   = "ha"
n8n_prefix             = "n8n"
drive_prefix           = "drive"
```

Initialize and apply:
```bash
terraform -chdir=infra init
terraform -chdir=infra apply
```

Outputs:
- `cloudflare_tunnel_token` (sensitive) – token for a Cloudflared connector, if/when you choose to run one.

## Modular ingress pattern
Each service file defines a local ingress list and its DNS record.

Example (`infra/homeassistant.tf`):
```20:31:/Users/mart.bent/Private/Git/homelab/infra/homeassistant.tf
locals {
  ingress_homeassistant = [
    {
      hostname = "${var.homeassistant_prefix}.${var.cloudflare_domain_name}"
      service  = "http://${var.host_local_ip}:8123"
    }
  ]
}
```

The tunnel config concatenates all service ingress locals and appends a default 404 rule:
```18:33:/Users/mart.bent/Private/Git/homelab/infra/main.tf
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
```

To add a new service:
1. Create `infra/<service>.tf` with its DNS record and `locals { ingress_<service> = [...] }`.
2. Append `local.ingress_<service>` to the `concat` list in `infra/main.tf`.
3. Run `terraform apply`.