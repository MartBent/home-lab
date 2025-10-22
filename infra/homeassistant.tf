// setup CNAME reccord for external access
resource "cloudflare_dns_record" "homeassistant_record" {
  zone_id = local.zone_id
  name    = var.homeassistant_prefix
  content = "${local.tunnel_id}.cfargotunnel.com"
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

// define ingress routing for homeassistant
locals {
  ingress_homeassistant = [
    {
      hostname = "${var.homeassistant_prefix}.${var.cloudflare_domain_name}"
      service  = "http://${var.host_local_ip}:8123"
    }
  ]
}

resource "docker_image" "homeassistant" {
  name = "ghcr.io/home-assistant/home-assistant:stable"
}

# Create a container
resource "docker_container" "homeassistant" {
  image        = docker_image.homeassistant.name
  name         = "homeassistant"
  network_mode = "host"
}
