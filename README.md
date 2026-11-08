# SumDeTing 🇧🇧 — Socratic AI Math Tutor

**Live:** https://sumdeting.246labs.cloud

A Bajan AI math tutor that refuses to just give you the answer. SumDeTing uses Claude on Amazon Bedrock with a Socratic system prompt: it asks what you've tried, points at where your work went wrong, and guides you to the solution one hint at a time. Math renders properly with KaTeX.

Built for Barbadian students: the tutor knows the local journey from Common Entrance (BSSEE) through CSEC/CXC Mathematics to CAPE, encourages in a warm Bajan voice while keeping every mathematical step in clear standard English, and uses everyday Barbadian contexts (BBD prices, bus fares, cricket) in its examples.

**Stack:** Claude (Amazon Bedrock Converse API) · AWS Lambda (Function URL) · S3 + CloudFront (OAC) · OpenTofu · Docker (hardened local runtime)

One codebase, two runtimes: `backend/tutor.mjs` powers both the serverless Lambda deployment and a hardened Docker container for local development.

## Architecture

```mermaid
flowchart LR
    U[Student's browser] -->|HTTPS| CF[CloudFront]
    CF --> S3[(S3: static web app)]
    CF -->|POST /api · SigV4 via OAC| FU[Lambda Function URL · IAM auth]
    FU --> L[Lambda: tutor handler]
    L -->|Converse API| B[Claude on Amazon Bedrock]
    CF -->|POST /api/account/* · SigV4 via OAC| AU[Lambda Function URL · account]
    AU --> AL[Lambda: account handler]
    AL --> D[(DynamoDB: accounts and progress)]
    AL -->|sign-in and consent emails| SES[Amazon SES]
    EB[EventBridge Scheduler] -->|daily| J[Lambda: janitor]
    J --> D
    J --> SES
```

The frontend is a single HTML page. KaTeX, marked, DOMPurify and the brand fonts are self-hosted under `web/vendor/`, so the CSP allows only the site's own origin. The backend is one Node.js Lambda that validates the conversation, applies the Socratic tutoring prompt, and calls the Bedrock Converse API. Chats are never stored server-side: the conversation lives in the student's browser (localStorage, 24h) so a refresh doesn't lose their session. Accounts are optional. A signed-in student's practice progress (topics, problems solved, streak, preferences) and profile details are stored in DynamoDB so it follows them across devices; an account Lambda handles sign-in (emailed links and codes via SES), parent and guardian access and under-13 parental consent, and an EventBridge Scheduler janitor deletes expired and inactive data. See the [privacy notice draft](web/privacy.html) and the [launch runbook](docs/launch-runbook.md).

## Why Socratic?

Tutoring tools that hand out answers optimize for homework completion, not learning. The system prompt enforces pedagogy: never reveal the final answer, one hint per turn, locate the student's error and ask a question about it, confirm and recap only once the student gets there themselves. Prompt design is the core of this project; see `SYSTEM_PROMPT` in `backend/tutor.mjs`.

## Why Bajan?

Most AI tutors default to US curricula and contexts. SumDeTing is syllabus-aware for the Caribbean (CXC methods for CSEC students, not whatever a generic model assumes) and meets students in a familiar voice. The persona rules are deliberate: dialect for warmth and encouragement only, standard English for every mathematical statement, and no caricature.

## Run locally with Docker

The same tutor logic (`backend/tutor.mjs`) runs in a hardened container for local development and demos. You need AWS credentials with Bedrock access (via `~/.aws` or environment variables). Use Docker Engine 28.0.0 or later: the port is published on `127.0.0.1` only, and older Linux engines don't fully isolate localhost-published ports from the local network.

```bash
docker compose up --build
# open http://localhost:8080
```

The image follows container-hardening practice: multi-stage build, non-root `node` user, read-only filesystem, all capabilities dropped, `no-new-privileges`, and a healthcheck on `/healthz`.

### Accounts in local development

```bash
ACCOUNT_DEV=1 node server.mjs
```

`ACCOUNT_DEV=1` swaps DynamoDB and SES for an in-memory store and a dev outbox. Emails the app would send (sign-in links, codes, consent requests) are readable at `http://localhost:8080/api/account/_dev/outbox`. Data is lost on restart.

## Tests

```bash
cd backend && npm test                      # account backend unit tests
cd e2e && npm ci && npx playwright install chromium && npx playwright test   # browser tests
```

The end-to-end suite starts its own server with `ACCOUNT_DEV=1` on port 8099. Before a public launch, work through [docs/launch-runbook.md](docs/launch-runbook.md).

## Deploy to AWS

Prerequisites: an AWS account with Bedrock model access enabled for Claude (check the model ID in `infra/variables.tf`), plus OpenTofu or Terraform.

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # then fill in your own values, including domain_name (or "" for no custom domain)
tofu init
tofu apply
```

For a fresh deployment without a custom domain, set `domain_name = ""` and leave `dns_role_arn` empty; the AWS provider then skips the cross-account DNS role. If DNS records were created earlier, removing them still needs working DNS-role credentials.

Outputs include `site_url` (the CloudFront URL) and `api_url` (the same-origin `/api` path). The Function URL itself requires IAM auth. Its resource policy grants invoke access only to this CloudFront distribution, which signs requests with Origin Access Control, so anonymous callers can't reach it directly. IAM principals in your own account with Lambda invoke permissions still can, and those calls bypass CloudFront. The `/api` path through CloudFront is still public and anonymous by design, so anyone can trigger Bedrock calls billed to your account; add a WAF rate limit in front of it before you share the site widely. A monthly cost budget emails `alert_email` (set in `infra/terraform.tfvars`) when spend runs hot, but it only alerts: it doesn't cap spend. The limit is `monthly_budget_usd` in `infra/variables.tf`.

Cost: serverless throughout; a few cents per study session with Claude Haiku.

## Features

- **Never gives the answer.** The golden rule: when a student is stuck, the tutor fully works a parallel example with different numbers, then lets them apply the method to their own problem.
- **Photo homework input.** Snap the problem; images are downscaled client-side and sent to Claude's vision via Bedrock Converse image blocks.
- **Practice mode.** Pick a level (Common Entrance through CAPE) and topic; the tutor generates one Bajan-context problem at a time.
- **Streaming replies.** Tokens render as they arrive: ConverseStream in the container, Lambda response streaming (`RESPONSE_STREAM` Function URL) in AWS, with a buffered fallback.
- **Session recap.** One click produces a printable, KaTeX-rendered study sheet of the session: methods used, mistakes to watch, fresh practice problems.
- **CSEC past papers.** A built-in drawer links to 47 real CSEC Mathematics papers (2004–2025, hosted by [CSEC Math Tutor](https://www.csecmathtutor.com/past-papers.html)). Open one, screenshot a question, send it with the photo button, and the tutor works it with you.

## Security

- The Lambda Function URL requires IAM auth; only this CloudFront distribution can call it (Origin Access Control, SigV4).
- The Lambda role can invoke one Bedrock model and nothing else. The model ID comes from configuration, never from the request.
- Every request is size-capped (turns, characters, photos) before the model is called, and model replies are sanitized with DOMPurify before they reach the page.
- Security headers (CSP locked to `'self'`, HSTS, `frame-ancestors 'none'`) are set at CloudFront.
- The code is audited with Cloudflare's [security-audit skill](https://github.com/cloudflare/security-audit-skill); findings are fixed in the open.

Found a vulnerability? Please open a private [security advisory](https://github.com/chrisfixesit/Sumdeting/security/advisories/new) rather than a public issue.

## Roadmap

- Voice input for younger students
- Teacher view with class-level progress summaries

## License

MIT — built by [Christopher Corbin](https://christophercorbin.cloud)
