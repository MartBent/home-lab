// setup CNAME reccord for external access
resource "cloudflare_dns_record" "belegtools_record" {
  zone_id = local.zone_id
  name    = var.belegtools_prefix
  content = "${local.tunnel_id}.cfargotunnel.com"
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

// define ingress routing for belegtools
locals {
  ingress_belegtools = [
    {
      hostname = "${var.belegtools_prefix}.${var.cloudflare_domain_name}"
      service  = "http://${var.host_local_ip}:3000"
    }
  ]
}
