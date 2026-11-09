# Launch runbook: SumDeTing accounts

For the owner. This covers turning on the cross-device accounts feature (sign-in by emailed link, student profiles, parent consent) in the live AWS account.

Every command below changes or reads a live AWS account. Always pass an explicit `--profile <sumdeting account profile>`. If the target is a production account, confirm with yourself (or the account owner) before each change. Names are fixed by the tofu stack: functions `sumdeting-account` and `sumdeting-janitor`, table `sumdeting-accounts`, domain `sumdeting.246labs.cloud`. If your SSO session has expired, run `aws sso login --sso-session <session>` first.

## 1. Lead-time request (do this first)

SES approval takes days, so file it before anything else.

Ask SES for production access. Until it is granted, SES only delivers to verified addresses, so real families will not receive sign-in or consent emails.

```
aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL \
  --website-url https://sumdeting.246labs.cloud \
  --use-case-description "Magic-link sign-in and parent consent emails for a children's maths tutor. Low volume, transactional only." \
  --profile <sumdeting account profile>
```

Check status:

```
aws sesv2 get-account --profile <sumdeting account profile>
```
Look for `ProductionAccessEnabled: true`.

**Optional: a higher Lambda concurrency limit.** The account allows 10 Lambda runs at once, shared by the tutor and the account functions. As of 2026-11-08 this is not needed: over the previous 30 days the account peaked at 1 concurrent run, with 0 throttles (CloudWatch `ConcurrentExecutions` and `Throttles`). It would only matter when more than about 10 tutor replies stream at the same moment, such as a whole class asking together. The `math-mentor-lambda-throttles` alarm emails on the first refused request, so wait for that signal or for planned whole-class use. Then open an AWS Support case (category *General*; Lambda isn't listed as a service there) asking for 100. The Service Quotas API won't take it, because it only accepts values above 1000.

You do not have to wait for approval to deploy. While SES is in sandbox, test only with a verified inbox: `aws sesv2 create-email-identity --email-identity you@example.com --profile <...>`, then click the link AWS emails you. Leave function concurrency settings in the tofu stack at their defaults; with a limit of 10, reserved concurrency would starve the tutor.

## 2. Deploy

1. Infrastructure is not applied from this repo (`infra/` is retired; never run `tofu apply` there). It lives in chrisfixesit/tofu-or-not-tofu. Merge these PRs (owner) and CI applies them:
   - Tofu PR #40, `accounts/eportfolio-prod/sumdeting`: the DynamoDB table `sumdeting-accounts`, the account Lambda `sumdeting-account` and its log group, the CloudFront `/api/account/*` behaviour, the SES domain identity, the janitor Lambda `sumdeting-janitor` (5-minute timeout) with its log group and daily schedule, and CloudWatch alarms (account errors, janitor errors, janitor record failures) that email the alerts topic. Confirm the SNS subscription email if you haven't already.
   - The DKIM records PR in `management/dns`.
   - The github-deploy PR that lets the `sumdeting-github-deploy` role update the code of the two new functions.
2. Merge this Sumdeting PR (#19) to `main` and approve the `production` environment. `.github/workflows/deploy.yml` ships the code to `math-mentor`, `sumdeting-account` and `sumdeting-janitor`, uploads the site and invalidates CloudFront. Merge the tofu PRs first, so the functions exist and have their configuration.
3. Privacy guard: the deploy job fails before uploading anything while `web/privacy.html` still contains "owner to fill in" or a DRAFT marker, so the draft notice can't reach production by accident. Finish section 4 first. Set the repository or environment variable `ALLOW_DRAFT_PRIVACY` to `true` only for a non-public test deploy, and never leave it set for launch. (The post-deploy smoke test also rejects a draft page, so expect it to fail on a draft deploy.)
4. Wait for DKIM to verify (usually a few minutes, can take up to 72 hours):

   ```
   aws sesv2 get-email-identity --email-identity sumdeting.246labs.cloud --profile <sumdeting account profile> \
     --query 'DkimAttributes.Status'
   ```
   Repeat until it prints `"SUCCESS"`. Do not test sign-in before then.

## 3. Post-deploy checks

(a) The API is reachable and refuses anonymous callers. CloudFront signs requests to the Function URL, so POST requests need the SHA-256 of the exact body sent:

```
BODY='{}'
curl -s -i -X POST https://sumdeting.246labs.cloud/api/account/me \
  -H 'content-type: application/json' \
  -H "x-amz-content-sha256: $(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1)" \
  --data "$BODY"
```
Expect HTTP 401 with `{"error":"not_signed_in"}`. A 403 usually means the hash did not match the body.

(b) Real sign-in. Open the site, choose to sign in, and use a test inbox (a verified address while SES is in sandbox). The email should arrive from the sender address configured in the tofu stack; click the link and confirm you are signed in. This proves the Lambda can use DynamoDB and SES.

(c) SDK check. The Lambda relies on the AWS SDK that the Node runtime provides. If sign-in fails with `Cannot find package '@aws-sdk/...'` in the logs, bundle `backend/node_modules` into the account Lambda package only (not the tutor Lambda), then ask for a change in the tofu stack or the deploy zip.

(d) Run the janitor once by hand:

```
aws lambda invoke --function-name sumdeting-janitor --payload '{"janitor":true}' \
  --cli-binary-format raw-in-base64-out out.json --profile <sumdeting account profile>
cat out.json
```
Expect `StatusCode: 200`, no `FunctionError`, and counts such as `{"warned":0,"deletedAccounts":0,"deletedAwaiting":0,"deletedUnfinished":0}`. On a brand-new launch all counts should be 0. Delete `out.json` afterwards.

(e) Check logs for errors:

```
aws logs tail /aws/lambda/sumdeting-account --since 30m --profile <sumdeting account profile>
aws logs tail /aws/lambda/sumdeting-janitor --since 30m --profile <sumdeting account profile>
```
Look for stack traces, `Missing required environment variable`, SES errors (for example `MessageRejected` while in sandbox with an unverified recipient), or janitor lines starting `Janitor:` (one record it couldn't process; these also raise the `sumdeting-janitor-record-failures` alarm).

## 4. Privacy notice review (before public launch)

The service stores children's data (names, profile and progress data) and parent email addresses. `web/privacy.html` is a draft until this section is done, and the deploy workflow refuses to deploy it while it contains "owner to fill in" or a DRAFT marker (unless `ALLOW_DRAFT_PRIVACY` is `true`, see section 2). Before announcing it publicly:

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
- To switch the feature off quickly, revert the site change (a revert PR to `main` redeploys) and the CloudFront behaviour in the tofu stack. The DynamoDB table has deletion protection on, so `tofu` will refuse to destroy it. That is intentional. To remove it deliberately, set `deletion_protection_enabled = false` in the tofu stack, apply, and only then remove the table.
- DynamoDB has point-in-time recovery (PITR, AWS default 35-day window). To restore after bad data or an accidental delete, restore to a NEW table (you cannot restore over the existing one):

  ```
  aws dynamodb restore-table-to-point-in-time \
    --source-table-name sumdeting-accounts --target-table-name sumdeting-accounts-restored \
    --use-latest-restorable-time --profile <sumdeting account profile>
  ```
  Then check the data in the new table, and either point the Lambda `TABLE_NAME` at it or copy items back. Importing the restored table into the tofu state needs care, so ask for a second pair of eyes first.
- A point-in-time restore brings back everything as it was at that moment, including accounts and profiles that were deleted after it (by their owners, by a decline, or by the janitor). Before switching the Lambdas to a restored table: list the deletions made since the restore point (owner requests you have a record of, and the janitor's daily counts in `/aws/lambda/sumdeting-janitor`), repeat each owner-requested deletion against the restored table, run the janitor once against it (section 3(d), with `TABLE_NAME` pointing at the restored table), and check that the deleted accounts and profiles are really gone. Only then switch over.
- Stop the janitor while investigating a data problem: disable the janitor schedule in the tofu stack (`accounts/eportfolio-prod/sumdeting`, via a PR; CI applies it), or as an emergency measure disable the EventBridge schedule in the console and record that you did. Re-enable it to resume.
