// setup CNAME reccord for external access
resource "cloudflare_dns_record" "echo_record" {
  zone_id = local.zone_id
  name    = var.echo_prefix
  content = "${local.tunnel_id}.cfargotunnel.com"
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

// define ingress routing for echo-server
locals {
  ingress_echo = [
    {
      hostname = "${var.echo_prefix}.${var.cloudflare_domain_name}"
      service  = "http://${var.host_local_ip}:8082"
    }
  ]
}
