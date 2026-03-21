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
