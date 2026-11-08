terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.region
}

# Cross-account provider: assumes Route53RecordWriter in the DNS management
# account (var.dns_role_arn) to write records in the site's hosted zone.
provider "aws" {
  alias  = "dns"
  region = "us-east-1"
  assume_role {
    role_arn    = var.dns_role_arn
    external_id = var.dns_external_id
  }
}

# ---------- Lambda ----------

data "archive_file" "handler" {
  type        = "zip"
  source_dir  = "${path.module}/../backend"
  excludes    = ["node_modules", "package.json"]
  output_path = "${path.module}/.build/handler.zip"
}

resource "aws_iam_role" "lambda" {
  name = "${var.project}-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "bedrock" {
  name = "${var.project}-bedrock-invoke"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
      ]
      # Cross-region inference profile + the underlying foundation models it
      # routes to (us-east-1 / us-east-2 / us-west-2).
      Resource = [
        "arn:aws:bedrock:${var.region}:${data.aws_caller_identity.current.account_id}:inference-profile/${var.model_id}",
        "arn:aws:bedrock:*::foundation-model/${replace(var.model_id, "us.", "")}",
      ]
    }]
  })
}

resource "aws_lambda_function" "tutor" {
  function_name    = var.project
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "handler.handler"
  filename         = data.archive_file.handler.output_path
  source_code_hash = data.archive_file.handler.output_base64sha256
  timeout          = 60
  memory_size      = 256

  # Caps parallel invocations so a scripted abuser can't run up the Bedrock
  # bill; plenty for a classroom of concurrent students. -1 = no reservation
  # (default), which this account requires: its total concurrency limit is 10,
  # so reserving any leaves <10 unreserved (not allowed). The account limit of
  # 10 itself acts as the cap. Raise this after a Service Quotas limit increase.
  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = {
      MODEL_ID = var.model_id
    }
  }
}

# The Function URL is no longer public: it requires SigV4 (AWS_IAM) and only
# CloudFront — via Origin Access Control — is granted invoke permission.
# Browsers reach it same-origin at https://<distribution>/api.
resource "aws_lambda_function_url" "tutor" {
  function_name      = aws_lambda_function.tutor.function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "RESPONSE_STREAM"
}

resource "aws_lambda_permission" "cloudfront_url" {
  statement_id  = "AllowCloudFrontInvokeFunctionUrl"
  action        = "lambda:InvokeFunctionUrl"
  function_name = aws_lambda_function.tutor.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.web.arn
}

# RESPONSE_STREAM URLs also need lambda:InvokeFunction on the resource policy;
# scoped to this distribution instead of the old public ("*") grant.
resource "aws_lambda_permission" "cloudfront_invoke_function" {
  statement_id  = "AllowCloudFrontInvokeForStreaming"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tutor.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.web.arn
}

# ---------- Static site (S3 + CloudFront with OAC) ----------

resource "aws_s3_bucket" "web" {
  bucket = "${var.project}-web-${data.aws_caller_identity.current.account_id}"
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

locals {
  # Same-origin API path (CloudFront /api behavior) + canonical/OG URLs
  # rewritten to the custom domain once it is live.
  index_html = replace(
    replace(file("${path.module}/../web/index.html"), "%%API_URL%%", "/api"),
    "https://d297i0l0pfbu7x.cloudfront.net",
    local.site_origin
  )
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.web.id
  key          = "index.html"
  content_type = "text/html"
  content      = local.index_html
  etag         = md5(local.index_html)
}

resource "aws_s3_object" "manifest" {
  bucket       = aws_s3_bucket.web.id
  key          = "manifest.webmanifest"
  content_type = "application/manifest+json"
  content      = file("${path.module}/../web/manifest.webmanifest")
  etag         = md5(file("${path.module}/../web/manifest.webmanifest"))
}

# Social-share image (Open Graph / Twitter) and apple-touch icon, referenced from index.html <head>.
resource "aws_s3_object" "og_image" {
  bucket       = aws_s3_bucket.web.id
  key          = "og-image.png"
  content_type = "image/png"
  source       = "${path.module}/../web/og-image.png"
  etag         = filemd5("${path.module}/../web/og-image.png")
}

resource "aws_s3_object" "apple_touch_icon" {
  bucket       = aws_s3_bucket.web.id
  key          = "apple-touch-icon.png"
  content_type = "image/png"
  source       = "${path.module}/../web/apple-touch-icon.png"
  etag         = filemd5("${path.module}/../web/apple-touch-icon.png")
}

# Self-hosted third-party assets (fonts, KaTeX + its fonts, marked, DOMPurify).
# Serving these from our own origin removes all runtime CDN dependencies —
# after two silent production breakages via cdnjs (missing version 503s, then
# wrong SRI hashes) — and lets the CSP stay locked to 'self'.
locals {
  vendor_files = fileset("${path.module}/../web/vendor", "**")
  vendor_mime = {
    css   = "text/css"
    js    = "text/javascript"
    mjs   = "text/javascript"
    woff2 = "font/woff2"
    woff  = "font/woff"
    ttf   = "font/ttf"
    map   = "application/json"
  }
}

# Versioned paths (katex-0.16.21/...) make these safe to cache hard.
resource "aws_s3_object" "vendor" {
  for_each      = { for f in local.vendor_files : f => f }
  bucket        = aws_s3_bucket.web.id
  key           = "vendor/${each.value}"
  source        = "${path.module}/../web/vendor/${each.value}"
  etag          = filemd5("${path.module}/../web/vendor/${each.value}")
  content_type  = lookup(local.vendor_mime, regex("\\.([a-z0-9]+)$", each.value)[0], "application/octet-stream")
  cache_control = "public, max-age=31536000, immutable"
}

# SumDeTing brand images referenced by index.html <head> and the manifest.
resource "aws_s3_object" "brand_images" {
  for_each = toset([
    "sumdeting-favicon-app.png",
    "sumdeting-icon-blue.png",
    "sumdeting-icon-cream.png",
    "sumdeting-app-light.png",
  ])
  bucket       = aws_s3_bucket.web.id
  key          = each.value
  content_type = "image/png"
  source       = "${path.module}/../web/${each.value}"
  etag         = filemd5("${path.module}/../web/${each.value}")
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${var.project}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# OAC for the Lambda Function URL origin: CloudFront SigV4-signs requests so
# the AWS_IAM-protected URL only accepts traffic from this distribution.
resource "aws_cloudfront_origin_access_control" "api" {
  name                              = "${var.project}-api-oac"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Security headers for the static site. CSP is locked to 'self' only: every
# third-party asset (fonts, KaTeX, marked, DOMPurify) is self-hosted under
# /vendor. NOTE: the previous cdnjs-based CSP silently blocked the Google
# Fonts stylesheet the redesign added (fonts.googleapis.com was never in
# style-src), so the brand typography never loaded in production — fixed by
# self-hosting the fonts.
resource "aws_cloudfront_response_headers_policy" "security" {
  name = "${var.project}-security-headers"

  security_headers_config {
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }
    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
      override                = true
    }
  }
}

locals {
  # "https://abc123.lambda-url.us-east-1.on.aws/" -> "abc123.lambda-url.us-east-1.on.aws"
  api_origin_domain = trimsuffix(trimprefix(aws_lambda_function_url.tutor.function_url, "https://"), "/")
  use_custom_domain = var.domain_name != ""
  # Canonical origin baked into the page's <head> (canonical/OG/Twitter URLs).
  site_origin = local.use_custom_domain ? "https://${var.domain_name}" : "https://d297i0l0pfbu7x.cloudfront.net"
}

# ---------- Custom domain (DNS managed in Route53 via aws.dns) ----------

resource "aws_acm_certificate" "custom" {
  count             = var.domain_name != "" ? 1 : 0
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records written cross-account into the authoritative zone.
resource "aws_route53_record" "acm_validation" {
  for_each = local.use_custom_domain ? {
    for o in aws_acm_certificate.custom[0].domain_validation_options : o.domain_name => {
      name   = o.resource_record_name
      type   = o.resource_record_type
      record = o.resource_record_value
    }
  } : {}

  provider        = aws.dns
  zone_id         = var.dns_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "custom" {
  count                   = local.use_custom_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.custom[0].arn
  validation_record_fqdns = [for r in aws_route53_record.acm_validation : r.fqdn]
}

# Public alias records -> CloudFront.
resource "aws_route53_record" "alias_a" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.dns
  zone_id  = var.dns_zone_id
  name     = var.domain_name
  type     = "A"
  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "alias_aaaa" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.dns
  zone_id  = var.dns_zone_id
  name     = var.domain_name
  type     = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}

# CloudFront access logs (who is using the tutor, and what errors they see).
resource "aws_s3_bucket" "logs" {
  bucket = "${var.project}-logs-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CloudFront standard logging writes via the S3 log-delivery group, which
# requires ACLs to be enabled on the bucket.
resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    object_ownership = "ObjectWriter"
  }
}

resource "aws_s3_bucket_acl" "logs" {
  depends_on = [aws_s3_bucket_ownership_controls.logs]
  bucket     = aws_s3_bucket.logs.id
  acl        = "log-delivery-write"
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire-old-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  aliases = local.use_custom_domain ? [var.domain_name] : []

  logging_config {
    bucket          = aws_s3_bucket.logs.bucket_domain_name
    prefix          = "cloudfront/"
    include_cookies = false
  }

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "s3-web"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    domain_name              = local.api_origin_domain
    origin_id                = "lambda-api"
    origin_access_control_id = aws_cloudfront_origin_access_control.api.id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "s3-web"
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # Tutor API, same-origin for the browser (no CORS, no exposed function URL).
  ordered_cache_behavior {
    path_pattern             = "/api"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    target_origin_id         = "lambda-api"
    viewer_protocol_policy   = "https-only"
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # Managed-CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # Managed-AllViewerExceptHostHeader
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  # Default *.cloudfront.net cert when domain_name is empty; otherwise the
  # ACM cert with SNI and TLSv1.2_2021 minimum. Referencing the cert ARN
  # through the validation resource forces the wait-for-ISSUED ordering.
  viewer_certificate {
    cloudfront_default_certificate = local.use_custom_domain ? null : true
    acm_certificate_arn            = local.use_custom_domain ? aws_acm_certificate_validation.custom[0].certificate_arn : null
    ssl_support_method             = local.use_custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.use_custom_domain ? "TLSv1.2_2021" : null
  }
}

# ---------- Error monitoring ----------

resource "aws_sns_topic" "alerts" {
  name = "${var.project}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Fires when the tutor Lambda throws (Bedrock failures, bugs) so problems are
# noticed before a student reports them.
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${var.project}-lambda-errors"
  alarm_description   = "MathMentor tutor Lambda reported errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.tutor.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Throttles mean the reserved-concurrency cap (10) is being hit — either real
# classroom load (raise it) or abuse (investigate the CloudFront logs).
resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${var.project}-lambda-throttles"
  alarm_description   = "MathMentor tutor Lambda is being throttled (concurrency cap reached)"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.tutor.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ---------- Cost guardrail ----------

# Account-wide monthly cost alert (Bedrock abuse would show up here first).
resource "aws_budgets_budget" "monthly" {
  name         = "${var.project}-monthly-cost"
  budget_type  = "COST"
  limit_amount = var.monthly_budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.web.arn
        }
      }
    }]
  })
}
