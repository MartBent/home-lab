variable "host_local_ip" {
  type     = string
  nullable = false
}
variable "cloudflare_api_token" {
  type     = string
  nullable = false
}
variable "homeassistant_prefix" {
  type     = string
  default  = "ha"
  nullable = false
}
variable "n8n_prefix" {
  type     = string
  default  = "n8n"
  nullable = false
}
variable "drive_prefix" {
  type     = string
  default  = "drive"
  nullable = false
}
variable "cloudflare_tunnel_name" {
  type     = string
  default  = "homelab-tunnel"
  nullable = false
}
variable "cloudflare_domain_name" {
  type     = string
  nullable = false
}

variable "docker_host" {
  type     = string
  default  = "unix:///var/run/docker.sock"
  nullable = false
}
