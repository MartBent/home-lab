// setup CNAME reccord for external access
resource "cloudflare_dns_record" "rfid_analyzer_record" {
  zone_id = local.zone_id
  name    = var.rfid_analyzer_prefix
  content = "${local.tunnel_id}.cfargotunnel.com"
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

// define ingress routing for rfid-analyzer
locals {
  ingress_rfid_analyzer = [
    {
      hostname = "${var.rfid_analyzer_prefix}.${var.cloudflare_domain_name}"
      service  = "http://${var.host_local_ip}:8080"
    }
  ]
}
