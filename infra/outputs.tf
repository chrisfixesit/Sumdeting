output "api_url" {
  description = "Tutor API endpoint (same-origin via CloudFront; the raw function URL is IAM-protected)"
  value       = "https://${aws_cloudfront_distribution.web.domain_name}/api"
}

output "site_url" {
  description = "CloudFront URL of the MathMentor web app (CNAME target for the custom domain)"
  value       = "https://${aws_cloudfront_distribution.web.domain_name}"
}

output "custom_domain_url" {
  description = "Custom-domain URL (active when domain_name is set)"
  value       = var.domain_name != "" ? "https://${var.domain_name}" : "(disabled)"
}

# ACM validation records are now managed automatically via aws_route53_record.acm_validation.
output "domain_validation_record" {
  description = "ACM validation CNAME options (informational — Route53 records are managed by Terraform)"
  value = var.domain_name == "" ? {} : {
    for o in aws_acm_certificate.custom[0].domain_validation_options :
    o.resource_record_name => o.resource_record_value
  }
}
