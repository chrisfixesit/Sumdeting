# Launch runbook: SumDeTing accounts

For the owner. This covers turning on the cross-device accounts feature (sign-in by emailed link, student profiles, parent consent) in the live AWS account.

Every command below changes or reads a live AWS account. Always pass an explicit `--profile <sumdeting account profile>`. If the target is a production account, confirm with yourself (or the account owner) before each change. Replace `<project>` with the `project` variable (default `math-mentor`) and `<domain>` with `domain_name` (default `sumdeting.246labs.cloud`). If your SSO session has expired, run `aws sso login --sso-session <session>` first.

## 1. Lead-time requests (do these first)

Both take days to be approved, so file them before anything else.

1. Ask SES for production access. Until it is granted, SES only delivers to verified addresses, so real families will not receive sign-in or consent emails.

   ```
   aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL \
     --website-url https://sumdeting.246labs.cloud \
     --use-case-description "Magic-link sign-in and parent consent emails for a children's maths tutor. Low volume, transactional only." \
     --profile <sumdeting account profile>
   ```

2. Ask for a higher Lambda concurrency quota (10 to 100).

   ```
   aws service-quotas request-service-quota-increase --service-code lambda \
     --quota-code L-B99A9384 --desired-value 100 --profile <sumdeting account profile>
   ```

Check status:

```
aws sesv2 get-account --profile <sumdeting account profile>
```
Look for `ProductionAccessEnabled: true`.

```
aws service-quotas get-service-quota --service-code lambda --quota-code L-B99A9384 \
  --profile <sumdeting account profile>
aws service-quotas get-requested-service-quota-change-history-by-quota \
  --service-code lambda --quota-code L-B99A9384 --profile <sumdeting account profile>
```
The first shows the current value. The second shows the request status (`PENDING`, `APPROVED`, `DENIED`).

You do not have to wait for approval to deploy. While SES is in sandbox, test only with a verified inbox: `aws sesv2 create-email-identity --email-identity you@example.com --profile <...>`, then click the link AWS emails you. Keep `reserved_concurrency` at `-1` until the quota increase is granted.

## 2. Deploy

1. From the repo root: `cd infra`.
2. Review the plan, then apply: `tofu plan`, then `tofu apply`.
   - Required variables (usually already set in your tfvars): `alert_email`, `dns_role_arn`, `dns_zone_id`, `dns_external_id`.
   - Optional: `domain_name` (default `sumdeting.246labs.cloud`) and `email_from` (empty means `SumDeTing <no-reply@<domain>>`; it must be on the verified domain).
   - `allow_draft_privacy` (bool, default `false`): the plan fails while `web/privacy.html` still contains the placeholder text "owner to fill in", so the draft notice can't reach production by accident. Finish section 4 first. Set it to `true` only for a non-public test deploy, and never leave it set in the production tfvars.
3. The apply creates the DynamoDB table `<project>-accounts`, the account Lambda `<project>-account` and its log group, the Function URL behind CloudFront at `/api/account/*`, the SES domain identity with DKIM records in Route53, the janitor Lambda `<project>-janitor` (same code and role, 5-minute timeout) with its own log group, the daily janitor schedule, and CloudWatch alarms (account errors, janitor errors, janitor record failures) that email `alert_email` through the existing alerts topic. Confirm the SNS subscription email if you haven't already.
4. Wait for DKIM to verify (usually a few minutes, can take up to 72 hours):

   ```
   aws sesv2 get-email-identity --email-identity <domain> --profile <sumdeting account profile> \
     --query 'DkimAttributes.Status'
   ```
   Repeat until it prints `"SUCCESS"`. Do not test sign-in before then.

## 3. Post-deploy checks

(a) The API is reachable and refuses anonymous callers. CloudFront signs requests to the Function URL, so POST requests need the SHA-256 of the exact body sent:

```
BODY='{}'
curl -s -i -X POST https://<domain>/api/account/me \
  -H 'content-type: application/json' \
  -H "x-amz-content-sha256: $(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1)" \
  --data "$BODY"
```
Expect HTTP 401 with `{"error":"not_signed_in"}`. A 403 usually means the hash did not match the body.

(b) Real sign-in. Open the site, choose to sign in, and use a test inbox (a verified address while SES is in sandbox). The email should arrive from the `email_from` address; click the link and confirm you are signed in. This proves the Lambda can use DynamoDB and SES.

(c) SDK check. The Lambda relies on the AWS SDK that the Node runtime provides. If sign-in fails with `Cannot find package '@aws-sdk/...'` in the logs, bundle `backend/node_modules` into the account Lambda package only (not the tutor Lambda), then apply again.

(d) Run the janitor once by hand:

```
aws lambda invoke --function-name <project>-janitor --payload '{"janitor":true}' \
  --cli-binary-format raw-in-base64-out out.json --profile <sumdeting account profile>
cat out.json
```
Expect `StatusCode: 200`, no `FunctionError`, and counts such as `{"warned":0,"deletedAccounts":0,"deletedAwaiting":0,"deletedUnfinished":0}`. On a brand-new launch all counts should be 0. Delete `out.json` afterwards.

(e) Check logs for errors:

```
aws logs tail /aws/lambda/<project>-account --since 30m --profile <sumdeting account profile>
aws logs tail /aws/lambda/<project>-janitor --since 30m --profile <sumdeting account profile>
```
Look for stack traces, `Missing required environment variable`, SES errors (for example `MessageRejected` while in sandbox with an unverified recipient), or janitor lines starting `Janitor:` (one record it couldn't process; these also raise the `<project>-janitor-record-failures` alarm).

## 4. Privacy notice review (before public launch)

The service stores children's data (names, profile and progress data) and parent email addresses. `web/privacy.html` is a draft until this section is done, and `tofu plan` refuses to deploy it while it contains "owner to fill in" (unless `allow_draft_privacy = true`, see section 2). Before announcing it publicly:

1. Review the privacy notice against the Barbados Data Protection Act 2019: what is collected, why, who can see it, and how a parent or student can see, correct or delete it. Check that the notice matches these rules in the code (keep this list and the notice in sync):
   - Sign-in links and codes expire after 15 minutes.
   - Invite and consent email links expire after 7 days.
   - Pending invites expire after 30 days.
   - Unfinished sign-ups are deleted after 7 days. (A parent's setup is complete as soon as they choose "parent", so this applies to accounts that never chose a type, and to students who never saved their own profile.)
   - Under-13 profiles still waiting for a parent are deleted after 7 days (counted from when they started waiting again, if their approving parent left).
   - The approving parent can withdraw approval (`/consent/withdraw`, behind the parent code): the profile, its progress and its access links are deleted at once, and the student account too if it owns nothing else.
   - If the approving parent removes their own link, deletes their account or is retention-deleted without withdrawing, and no other approving parent remains, the under-13 profile goes back to waiting: its server-side progress is deleted, a new consent email goes to the same parent address, and the 7-day rule applies again.
   - Inactive accounts get a warning email at 700 days idle and are deleted only when idle for more than 730 days and at least 30 days after the warning. Any activity resets this. The sign-in link in the warning email works for 30 days.
   - When an idle account is deleted, each child profile it owns that has a guardian who was active in the last 730 days moves to the most recently active guardian (who becomes the owner) instead of being deleted.
   - The sign-in cookie lasts until 90 days after last use.
   - IP addresses are used for rate limiting (sign-in: 300 an hour per IP) and the counter expires after an hour. Sign-in emails (5 an hour) and invite emails (5 a day) are counted per email address. Note that DynamoDB TTL can take up to a few days to physically remove an expired counter item; decide whether the notice's "up to an hour" / "up to a day" wording needs to reflect that.
   - CloudFront and Lambda logs (which can include IP addresses) are kept for 90 days.
   - On the device: practice progress, the unsent-updates queue and the signed-in marker live in browser storage and are cleared on sign-out.
2. Owner confirmations still open in the draft:
   - The sentence about the tutor sending chats and photos to Claude through Amazon Bedrock (Amazon Web Services): confirm it is accurate and complete for the model and region actually configured.
   - The contact address: replace "[contact email — owner to fill in]" in the Contact section with a real, monitored address.
   - Legal review: have the notice checked against the Data Protection Act 2019 (or record why that isn't needed).
3. Confirm the under-13 parent consent wording is accurate for what the app does.
4. When the notice is final, remove the `<!-- Draft: ... -->` comment at the top of `web/privacy.html` and update "Last updated". After deploying, the live smoke test checks that `/privacy.html` contains neither "DRAFT" nor "owner to fill in".
5. The owner signs off in writing (a dated note in the repo or an email to yourself is enough). Do not launch publicly until this is done.

## 5. Rollback and recovery

- The account feature is optional for students. If the account API misbehaves, the tutor itself keeps working, because it is a separate Lambda and the site does not need sign-in to be used.
- To switch the feature off quickly, revert the infra and site change and run `tofu apply` again. The DynamoDB table has deletion protection on, so `tofu` will refuse to destroy it. That is intentional. To remove it deliberately, set `deletion_protection_enabled = false`, apply, and only then remove the table.
- DynamoDB has point-in-time recovery (PITR, AWS default 35-day window). To restore after bad data or an accidental delete, restore to a NEW table (you cannot restore over the existing one):

  ```
  aws dynamodb restore-table-to-point-in-time \
    --source-table-name <project>-accounts --target-table-name <project>-accounts-restored \
    --use-latest-restorable-time --profile <sumdeting account profile>
  ```
  Then check the data in the new table, and either point the Lambda `TABLE_NAME` at it or copy items back. Importing the restored table into tofu state needs care, so ask for a second pair of eyes first.
- A point-in-time restore brings back everything as it was at that moment, including accounts and profiles that were deleted after it (by their owners, by a decline, or by the janitor). Before switching the Lambdas to a restored table: list the deletions made since the restore point (owner requests you have a record of, and the janitor's daily counts in `/aws/lambda/<project>-janitor`), repeat each owner-requested deletion against the restored table, run the janitor once against it (section 3(d), with `TABLE_NAME` pointing at the restored table), and check that the deleted accounts and profiles are really gone. Only then switch over.
- Stop the janitor while investigating a data problem: add `state = "DISABLED"` to `aws_scheduler_schedule.janitor` in `infra/main.tf` and run `tofu apply` (the argument is not set today). Remove it again to resume.
