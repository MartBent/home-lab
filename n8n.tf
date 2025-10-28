// setup CNAME reccord for external access
resource "cloudflare_dns_record" "n8n_record" {
  zone_id = local.zone_id
  name    = var.n8n_prefix
  content = "${local.tunnel_id}.cfargotunnel.com"
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

// define ingress routing for n8n
locals {
  ingress_n8n = [
    {
      hostname = "${var.n8n_prefix}.${var.cloudflare_domain_name}"
      service  = "http://${var.host_local_ip}:5678"
    }
  ]
}

resource "docker_image" "n8n" {
  name = "docker.n8n.io/n8nio/n8n:latest"
}

# Create a container
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
