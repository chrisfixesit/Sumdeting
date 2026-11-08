# Cross-device progress: accounts, student profiles and parent view

Date: 2026-11-08
Status: Draft for review

## Why

SumDeTing keeps each student's progress (streak, per-topic history, level and topic choices) in that one browser's `localStorage`. A student who practises on a school computer and then at home starts from zero at home, and anyone who clears the browser or uses a private window loses everything. Shared school computers make this worse.

This design adds optional sign-in with an emailed magic link so progress follows the student between devices, plus a protected parent view that shows how each child is doing. **It has to ship before public launch.**

Who it's for: Barbadian students preparing for Common Entrance (about 10–11 years old) and CSEC (and Add Maths and CAPE), and their parents.

## Goals

1. A student who signs in at school and at home sees the same streak, per-topic progress and practice preferences on both devices.
2. One email can hold several student profiles. A parent can sign up all their children with one email.
3. Students with their own email can sign up themselves.
4. Parents can see how each child is doing, and only the parent can open that view.
5. Parents can see the progress of a child who has their own separate account, once the link between them is approved.
6. A second parent or guardian with a different email can share a parent-created child, so the child keeps one progress record across two homes.
7. Students under 13 who sign up with their own email need a parent's approval before any progress is stored on the server.

## Non-goals (for launch)

- Syncing the chat conversation. Chats stay in the browser's `localStorage` for 24 hours, exactly as now. No chat text, and no photos, are stored on the server.
- Passwords or social sign-in (Google, Apple). Magic link only.
- Teacher or school dashboards, and grouping students by class.
- Showing the parent anything beyond the progress data listed below. Parents never see chats.
- Weekly progress emails or other notifications beyond the emails listed here.
**Launch scope:** everything in this document ships at launch. That includes the parent view, linking to children with their own accounts, second guardians, and the privacy notice page. Nothing is phased. There's no launch date yet, so start early on anything with outside lead time: SES production access, DKIM, and the Lambda quota increase.

## Anti-goals (it fails if this happens, even if it technically works)

- **Students who don't sign in are made worse off.** Signing in is optional. With no account, the app behaves exactly as it does today.
- **A child can open the parent view on a shared device.**
- **Collecting more about children than we need.** Store first name, last name, level and colour per student, and nothing else about them (no date of birth, school, photo or chat).
- **Progress gets lost when a student signs in.** Progress already on the device is merged into the profile, never discarded.
- **Sign-in delays launch through over-building.** Keep it to what's described here.

## Constraints

- Existing stack, to build on rather than replace: a single HTML page (`web/index.html`), one Node.js Lambda (`backend/handler.mjs` and `backend/tutor.mjs`) behind CloudFront at `/api` through a Function URL with OAC and SigV4, S3 for static files, and OpenTofu in `infra/`. The live domain is `sumdeting.246labs.cloud`.
- The CloudFront `/api` behaviour currently matches the exact path `/api`. New endpoints need either a `/api/*` behaviour or routing inside the single `/api` path. The builder chooses which.
- The CSP is locked to `'self'`. Everything stays same-origin.
- The account's Lambda concurrency limit is 10 in total, and it's shared with the tutor. Auth and sync calls must be fast and cheap.
- The docker runtime (`server.mjs`) mirrors the Lambda for local development. It should keep working, at least in a mode where auth is disabled or stubbed.
- **Email sending:** Amazon SES must be moved out of sandbox mode before launch, which needs an AWS support request and can take a day or more. The sending domain (`246labs.cloud` or `sumdeting.246labs.cloud`) needs DKIM records in the cross-account DNS zone, which the existing `aws.dns` provider can write.

## How it works for people

The mockups from the brainstorm are in `.superpowers/brainstorm/70060-1794155028/content/` (`signin-flow.html`, `signup-v2.html` and `parent-view.html`). Use them for layout and wording, but **use no emojis** in the real UI.

### Signing in

- A **profile icon** sits in the header next to the menu. When signed out it's an outline person icon. When signed in it shows the active student's initials in their colour.
- When signed out, the progress line gets a small "this device only" tag so students understand why signing in matters.
- Tapping the icon while signed out opens a bottom sheet titled "Keep your progress", with one email field ("Your email, or a parent's"), a button labelled "Email me a sign-in link", and "Not now".
- The email contains a **magic link and a 6-digit code**. Both expire after 15 minutes and work only once. The link signs in the device it's opened on. The code is for when the email is opened on a different device (for example, the parent's phone): the "Check your email" screen has a field to type it in. *(The code fallback is my call.)*
- Once signed in, a device stays signed in until the person signs out. *(The builder chooses the session length. 90 days with sliding renewal is a reasonable default.)*

### First sign-in from a new email: setting up

1. **"Who's setting this up?"** offers two choices: "I'm a parent or guardian" or "I'm a student".
2. **Parent path:** "Add your child" asks for first name, last name, level (Common Entrance / CSEC / Add Maths / CAPE) and a colour from 4–6 options. There's a required consent tick box: "I'm this child's parent or guardian, and I agree to SumDeTing saving their practice progress." The buttons are "Save and add another" and "Done, start practising".
3. **Student path:** the same fields, worded to the student, plus the question **"Are you 13 or older?"** (Yes / No). Store only the answer, never a date of birth.
   - **13 or older:** the student ticks "I agree to SumDeTing saving my practice progress" and can start straight away.
   - **Under 13 (needs a parent's approval):** the student types in a parent's or guardian's email instead of ticking a box. The profile is created in a **waiting for parent** state, and the parent gets an email: "<First name> wants to use SumDeTing. Approve saving their practice progress?" The email links to a sign-in where the parent sees the consent wording from the parent path and chooses Approve or Decline.
     - **Until approved:** the app works exactly as it does when signed out. Progress stays on the device only, and nothing about practice is stored on the server. A banner says "Waiting for your parent to approve. Your progress is saved on this device for now." It has a "Resend" option.
     - **On approval:** the parent gets an account (a parent account, if their email is new), the student's profile becomes active, device progress is offered for merging as normal, and the parent is **automatically linked view-only** to the child, as if the child had shared. The child can't remove that link while they're under 13. *(My call.)*
     - **On decline, or no answer after 7 days:** the waiting profile and its account details are deleted, and the device goes back to signed out. *(My call.)*
   - **Siblings on student accounts:** a student account can add another profile only if the account holder is 13 or older, and each added sibling goes through the same "13 or older?" question, so under-13 siblings need parent approval too. *(My call.)*

The parent's approval is recorded per profile (who approved and when). An under-13 student can't use "Stop sharing" on the parent who approved them. The approving parent can withdraw approval at any time, which deletes the profile and its progress (see "Withdrawing approval" under "Parent section"). If the approving parent instead leaves without withdrawing (removes their own link, deletes their account, or is deleted for inactivity) and no other approving parent remains, the profile goes back to waiting for approval: its saved progress on the server is deleted, the parent's email is kept and a fresh approval email is sent, the student keeps practising on the device as for any waiting profile (and can resend), and the usual 7-day rule runs from that moment.

The account records which path was taken (`parent` or `student`), because only parent accounts get the parent section.

### Who's practising?

- This appears after every sign-in and whenever the profile icon is tapped. It shows large tiles with initials, first name and level, plus an "Add a student" tile.
- Choosing a tile makes that student active on this device. Their level becomes the default level. Progress is recorded against that student.
- The profile menu, for a signed-in student, has: switch student, "Share my progress with a parent" (student accounts only), "Who can see my progress", and sign out.
- "Add a student" from this screen is a parent-only action on parent accounts (see the parent section below). On student accounts, adding brothers or sisters is allowed. *(My call: a student account can add siblings, but doesn't get a parent section.)*

### Merging progress already on the device

*(Local storage layout and the merge rules are my call.)*

- **Signed-out progress** stays in the existing key, `mathmentor.mastery.v1`, plus `PREFS_KEY`, exactly as today.
- **Signed-in progress** is cached locally under a separate key for each profile (for example `mathmentor.mastery.<profileId>`). It never shares the signed-out key.
- **On choosing a student**, if the signed-out key holds any progress, the app asks: "Add the progress on this device to <name>'s profile?" with **Add** and **Not mine**. Add merges it and then clears the signed-out key. Not mine leaves it alone. Asking prevents a student on a school computer from inheriting what the last anonymous user left behind.
- **On sign-out**, the device's cached profile copies are deleted, along with the 24-hour chat (see below). The device returns to its signed-out state, so the next person on a shared computer sees nothing of the previous student.
- **Practice after signing out** builds up in the signed-out key again, and is offered for merging at the next sign-in.
- **Chats and profiles:** the 24-hour chat is cleared whenever the active student changes or someone signs out, so one child never sees another's conversation and a parent unlocking the parent section never sees a child's chat.

Merge rules:

- Per-topic `attempted` and `solved`: add them together.
- Per-topic `hist`: combine both lists, order by date, keep the last 15.
- Streak: keep whichever is longer. The `days` counters are added together per date.
- Clearing the signed-out key after a merge ensures the same data is never added twice. After merging, the server copy is the source of truth for signed-in use.

### Recording progress while signed in

- Every place that currently writes `mathmentor.mastery.v1` or `PREFS_KEY` (`recordOutcome`, `recordActivity`, the preference `change` handlers) also syncs to the server for the active student.
- `difficultyGuidance()` and `trickyTopics()` keep working from a local copy of the active student's progress, refreshed from the server when the app loads and when the student is switched.
- If the network is down, writes are queued and retried, and the local copy stays usable. The app must never block practice because sync failed.
- When signed out, nothing changes from today.

### Parent section

- **Who can use it:** only accounts set up on the parent path.
- **Ways in:** "See how everyone is doing" under the Who's practising? tiles, and the same item in the profile menu.
- **Lock:** every time someone opens the parent section, a **6-digit code is emailed** to the account email, and the section opens only after the code is entered. Codes expire after 10 minutes and work only once. After unlocking, the section stays open on that device for a short window and re-locks when the window ends or the app is closed. *(My call: 15 minutes.)*
- **Behind the lock:** viewing progress, adding or removing a child, requesting access to a child's separate account, and seeing or ending links to children's own accounts.
- **Progress page for one child:** name, level and when they last practised; streak, problems solved and topics tried; topics grouped into "Needs practice" and "Going well", each with a bar, "X of Y solved" and a plain label:
  - **Finding it hard:** struggled (not solved, any hints, or 5 or more turns, the same `struggledEntry` rule as today) on 2 or more of the last 3 problems.
  - **Confident:** the last 2–3 were solved with no hints in 3 turns or fewer (the same rule `difficultyGuidance` uses to make problems harder).
  - **Getting there:** anything else.
- Children linked from their own accounts appear here too, marked "View only".

#### Withdrawing approval

- On the progress page of an under-13 child they approved, the parent sees "Withdraw approval and delete <First>'s data".
- It asks for confirmation (it can't be undone): it deletes the child's profile and progress from SumDeTing on every device, and the child can keep practising on their device without saving.
- It needs the parent section to be unlocked, like every other change there. Afterwards the list shows "Approval withdrawn. <First>'s data has been deleted."
- If the student account then owns no profiles, it is deleted too.

### Linking a parent to a child who has their own account

Either side can start it. Both lead to the same result: a view-only link that the student approved.

- **The student shares:** "Share my progress with a parent" lets the student enter the parent's email. The parent gets an email with a sign-in link. If the parent has no account, they're taken through the parent setup (they can add zero children of their own). The link is active once the student shares, because the student started it.
- **The parent requests:** in the parent section, "Add a child who has their own account" lets the parent enter the child's email. The child gets an email, and a notice next time they open the app: "<Parent email> wants to see your progress", with Allow and Decline. The link becomes active only when the child allows it. If no account exists for that email, the email invites them to sign up and the request waits until they do. *(My call.)*
- A linked parent can see only the progress page. They can't practise as the student, edit the profile, or see chats.
- The student's "Who can see my progress" lists the linked parents with a "Stop sharing" button for each. More than one parent or guardian can be linked.
- A student account that holds several sibling profiles shares per profile, not the whole account. When a parent's request reaches an email with several profiles, the Allow screen lets the student tick which profile or profiles it covers. *(My call.)*
- Requests can only go to student-type accounts. If the email entered belongs to a parent account, show: "That email is set up as a parent account." *(My call.)*

### Second guardian for a parent-created child

This is for separated or co-parenting families, where a child practises at two homes under two different emails.

- In the parent section (behind the lock), each child has **"Add another parent or guardian"**. The parent enters an email, and that person gets an email with a sign-in link. If their email is new, they go through parent setup (they can add zero children of their own).
- Once they've signed in, the child appears in **their** "Who's practising?" and in their parent section. The second guardian can **practise as the child** on their own devices (so the child keeps one progress record across both homes), see the progress page, and edit the child's name, level and colour. *(My call: practising matters most here, because the child goes to the second home.)*
- Only the guardian who created the profile can delete it. Either guardian can remove the second guardian's access, and a second guardian can remove themselves. *(My call.)*
- An invite that hasn't been accepted after 30 days expires, the same as link requests.
- Unlike view-only links to children with their own accounts, this gives full guardian access. The parent section labels the two clearly: "Guardian" and "View only".

### Removing data

Parents can remove a child profile (its progress is deleted). An account holder can delete their whole account from the profile menu, which deletes all profiles, progress and links. *(This is my call. It isn't one of the requirements you asked for, but holding children's data without a way to delete it would be a problem.)*

- **Parent accounts:** deleting the account sits behind the parent-section email code, like removing a child, so a child practising on the parent's login can't wipe it.
- **Student accounts:** deleting the account, or removing a sibling profile, needs a 6-digit code emailed to the account email.

**How long data is kept** *(my call; the privacy notice must state it)*:
- Accounts with no sign-in for 2 years are deleted, along with their profiles, progress and links. Send a warning email 30 days beforehand.
- Pending link requests expire after 30 days.
- Sign-ups that verified an email but never finished setup are deleted after 7 days.
- Sign-in tokens, codes and expired sessions are removed automatically (for example with a DynamoDB TTL).

## Data held on the server

Per account: email (normalised to lower case), type (`parent` or `student`), created date, consent date.
Per student profile: first name, last name, level, colour, created date, the account it belongs to, an under-13 flag, consent status (`active` or `awaiting_parent`), and who consented and when (the student themselves, or the approving parent's account).
Per student progress: the existing mastery shape (`topics` with `attempted`, `solved` and `hist`, plus `streak` and `days`) and the practice preferences (level, topic, exam length), with a last-updated time.
Per link: parent account, student profile, kind (`view_only` for a child's own account, or `guardian` for a second guardian), status (`pending` or `active`), who started it, created date.
Short-lived: sign-in tokens and codes, parent-section codes, and sessions. Store only hashes of the tokens and codes, and expire them.

No chat text, photos or tutor replies are stored.

## Left to the builder

- Database choice and table design. *(My suggestion: DynamoDB on-demand, for a serverless project of this size, managed in `infra/` with OpenTofu.)*
- Whether auth and sync live in the existing Lambda or a separate one, and how routes are laid out under `/api`.
- Session mechanism. *(An HttpOnly, Secure, SameSite=Lax cookie is the natural fit, since everything is same-origin. CloudFront's `AllViewerExceptHostHeader` origin request policy already forwards cookies.)*
- Rate limits on sending emails (per email address and per IP), and how they're enforced.
- Email template design and sender address. Keep it plain and on-brand, and say clearly what the email is for, because parents will receive it.
- Conflict handling when two devices write progress for the same student at once. Last-write-wins on the whole progress document is acceptable for launch if writes merge per topic. Losing an entire session's progress isn't acceptable.
- How the docker runtime handles auth locally.
- Tests and the smoke check (`.github/smoke/smoke.mjs`) updates.

## Launch checklist items this adds

- SES production access requested and approved, and DKIM verified for the sending domain.
- **A privacy notice page, built as part of this work.** It covers what's stored, why, for how long, who can see it (guardians and view-only parents), how under-13 approval works, and how to delete data. It's written in plain language for parents, linked from the sign-in sheet and from every email. The builder drafts it, the owner reviews and refines it with Claude, and it's checked against the Barbados Data Protection Act 2019 before launch.
- Update the README's "Nothing is stored server-side" statement.
- Request a Lambda concurrency quota increase. The account's limit is 10 in total, which a single class streaming tutor replies can already use up, before any sign-in or sync traffic is added. Separately, sync writes should be debounced (for example, at most one write per student every few seconds, plus one on page hide), and throttled requests should retry quietly. *(My call.)*
