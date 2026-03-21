// lookup belegtools.nl zone
data "cloudflare_zones" "belegtools" {
  name = var.belegtools_domain_name
}

locals {
  belegtools_zone_id = data.cloudflare_zones.belegtools.result[0].id
}

// CNAME on belegtools.nl (root domain)
resource "cloudflare_dns_record" "belegtools_root" {
  zone_id = local.belegtools_zone_id
  name    = "@"
  content = "${local.tunnel_id}.cfargotunnel.com"
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

// define ingress routing for belegtools
locals {
  ingress_belegtools = [
    {
      hostname = var.belegtools_domain_name
      service  = "http://${var.host_local_ip}:3000"
    }
  ]
}
