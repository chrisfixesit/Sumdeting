// Screens for the account UI. Everything stateful lives in account-ui.mjs and
// arrives through `ctx`, so this module only builds and wires up dialogs.
import { initials } from "./account-core.mjs";
import { nextId } from "./account-dom.mjs";

export const COLOURS = [
  ["#F4C143", "Gold"], ["#BFD0FF", "Blue"], ["#C8E6C9", "Green"],
  ["#F8C9B8", "Peach"], ["#E1C6F2", "Lilac"], ["#FFE0A3", "Sand"],
];
const LEVEL_LABEL = { "Additional Maths": "Add Maths" };
export const levelLabel = (level) => LEVEL_LABEL[level] ?? level;

const PARENT_CONSENT = "I'm this child's parent or guardian, and I agree to SumDeTing saving their practice progress.";
const STUDENT_CONSENT = "I agree to SumDeTing saving my practice progress.";
const SIBLING_CONSENT = "I agree to SumDeTing saving their practice progress.";

export function createScreens(ctx) {
  const { api, state, h, openDialog, showNotice, busy, errorLine, statusLine, messageFor, errorCode } = ctx;

  const primary = (text, attrs = {}) => h("button", { type: "submit", class: "acct-primary", ...attrs }, text);
  const secondary = (text, onClick, attrs = {}) =>
    h("button", { type: "button", class: "acct-secondary", on: { click: onClick }, ...attrs }, text);
  const link = (text, onClick, attrs = {}) =>
    h("button", { type: "button", class: "acct-link", on: { click: onClick }, ...attrs }, text);

  function textField(label, attrs = {}, hint) {
    const id = nextId("acct-f");
    const hintId = hint ? nextId("acct-h") : null;
    const input = h("input", { id, class: "acct-input", "aria-describedby": hintId, ...attrs });
    const wrap = h("div", { class: "acct-field" },
      h("label", { for: id }, label),
      hint ? h("p", { id: hintId, class: "acct-hint" }, hint) : null,
      input);
    return { wrap, input };
  }

  function radioGroup(legend, name, options, { checked, className = "" } = {}) {
    const inputs = [];
    const fs = h("fieldset", { class: `acct-fieldset ${className}` }, h("legend", {}, legend));
    const row = h("div", { class: "acct-choices" });
    for (const opt of options) {
      const id = nextId("acct-r");
      const input = h("input", { type: "radio", id, name, value: opt.value, checked: opt.value === checked });
      if (opt.ariaLabel) input.setAttribute("aria-label", opt.ariaLabel);
      inputs.push(input);
      row.append(h("label", { for: id, class: "acct-choice", style: opt.style }, input, opt.content ?? opt.label));
    }
    fs.append(row);
    return { fs, inputs, value: () => inputs.find((i) => i.checked)?.value ?? null };
  }

  function checkbox(label) {
    const id = nextId("acct-c");
    const input = h("input", { type: "checkbox", id });
    return { wrap: h("div", { class: "acct-check" }, input, h("label", { for: id }, label)), input };
  }

  // ---- Sign in ----

  let checkingEmail = null; // the open "Check your email" dialog, if any

  function openSignin(d = openDialog(), prefill = "") {
    checkingEmail = null;
    const email = textField("Email", {
      type: "email", autocomplete: "email", placeholder: "Your email, or a parent's",
      required: true, maxlength: "254", value: prefill,
    });
    const err = errorLine();
    const send = primary("Email me a sign-in link");
    const form = h("form", { class: "acct-form", novalidate: true },
      email.wrap, err,
      h("div", { class: "acct-actions" }, send, secondary("Not now", () => d.close())));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(send, async () => {
        const value = email.input.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return err.show("Enter an email address, like name@example.com.");
        const r = await api("/signin/start", { email: value });
        if (r.ok) checkEmail(d, value);
        else err.show(messageFor(r));
      });
    });
    d.render(
      h("h2", {}, "Keep your progress"),
      h("p", { class: "acct-sub" }, "Sign in to pick up where you left off at school or at home. No password needed."),
      form,
      h("p", { class: "acct-small" }, h("a", { href: "/privacy.html", target: "_blank", rel: "noopener" }, "How SumDeTing uses your information")),
    );
    return d;
  }

  function checkEmail(d, email) {
    checkingEmail = d;
    const code = textField("6-digit code", {
      inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", pattern: "[0-9]{6}",
      class: "acct-input acct-code",
    }, "Opened the email on another device? Type the code from it here.");
    const err = errorLine();
    const status = statusLine();
    const signin = primary("Sign in");
    const form = h("form", { class: "acct-form", novalidate: true }, code.wrap, err, signin);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(signin, async () => {
        const value = code.input.value.replace(/\s/g, "");
        if (!/^\d{6}$/.test(value)) return err.show("Enter the 6 numbers from the email.");
        const r = await api("/signin/verify", { email, code: value });
        if (r.ok && r.data?.signedIn) {
          checkingEmail = null;
          d.close();
          await ctx.afterSignIn(r.data);
        } else err.show(messageFor(r));
      });
    });
    const resend = link("Resend", () => busy(resend, async () => {
      err.show("");
      const r = await api("/signin/start", { email });
      if (r.ok) status.show("We sent a new email. Use the newest one.");
      else err.show(messageFor(r));
    }));
    d.render(
      h("h2", {}, "Check your email"),
      h("p", { class: "acct-sub" }, `We sent a link to ${ctx.maskEmail(email)}. Tap it on this device to sign in. It works for 15 minutes.`),
      form,
      status,
      h("div", { class: "acct-links" }, resend, link("Use a different email", () => openSignin(d, email))),
    );
  }

  /** If the magic link was opened in another tab, pick the session up here. */
  async function checkSignedInElsewhere() {
    const d = checkingEmail;
    if (!d?.open || state.me) return;
    const r = await api("/me");
    if (r.ok && r.data?.signedIn && d.open && !state.me) {
      checkingEmail = null;
      d.close();
      await ctx.afterSignIn(r.data);
    }
  }

  // ---- Setup ----

  function showSetup() {
    const d = openDialog();
    const err = errorLine();
    const choose = (type) => async (e) => {
      const btn = e.currentTarget;
      await busy(btn, async () => {
        if (type === "parent") {
          const r = await api("/setup", { type: "parent" });
          if (!r.ok && errorCode(r) !== "bad_request") return err.show(messageFor(r));
          state.me.account.type = "parent";
          state.me.parentUnlocked = true; // setup opens the parent section for a short while
        }
        d.close();
        openProfileForm(type === "parent" ? "parent" : "student-self");
      });
    };
    const option = (type, title, sub) =>
      h("button", { type: "button", class: "acct-option", on: { click: choose(type) } },
        h("span", { class: "acct-option-title" }, title), h("span", { class: "acct-option-sub" }, sub));
    d.render(
      h("p", { class: "acct-kicker" }, "Welcome to SumDeTing"),
      h("h2", {}, "Who's setting this up?"),
      h("p", { class: "acct-sub" }, "Your email is confirmed."),
      h("div", { class: "acct-options" },
        option("parent", "I'm a parent or guardian", "I'll add one or more of my children"),
        option("student", "I'm a student", "This is my own email")),
      err,
    );
  }

  // ---- Profile form (parent child, student self, student sibling) ----

  function openProfileForm(mode) {
    const d = openDialog();
    const me = state.me;
    const parent = mode === "parent";
    const self = mode === "student-self";
    const knownAge = self && typeof me.account.holderOver13 === "boolean" ? me.account.holderOver13 : null;
    let saved = 0;

    const first = textField(parent ? "Child's first name or nickname" : self ? "Your first name or nickname" : "First name or nickname",
      { maxlength: "40", autocomplete: self ? "given-name" : "off", required: true });
    const last = textField(parent ? "Child's last name" : self ? "Your last name" : "Last name",
      { maxlength: "40", autocomplete: self ? "family-name" : "off", required: true });
    const group = nextId("acct-g");
    const level = radioGroup(parent || !self ? "What are they studying for?" : "What are you studying for?", `${group}-level`,
      ctx.SD.levels.map((l) => ({ value: l, label: levelLabel(l) })), { className: "acct-levels" });
    const swatch = (hex) => h("span", { class: "acct-swatch", "aria-hidden": "true" });
    const colour = radioGroup("Pick a colour", `${group}-colour`,
      COLOURS.map(([hex, name]) => ({ value: hex, ariaLabel: name, content: swatch(hex), style: `--acct-colour:${hex}` })),
      { checked: COLOURS[0][0], className: "acct-colours" });
    const updateSwatches = () => {
      const text = initials(first.input.value, last.input.value);
      colour.fs.querySelectorAll(".acct-swatch").forEach((s) => { s.textContent = text; });
    };
    first.input.addEventListener("input", updateSwatches);
    last.input.addEventListener("input", updateSwatches);

    let age = null;
    let consent;
    let parentEmail = null;
    const ageBlock = h("div", {});
    if (parent) {
      consent = checkbox(PARENT_CONSENT);
    } else {
      age = radioGroup(self ? "Are you 13 or older?" : "Are they 13 or older?", `${group}-age`,
        [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
        { checked: knownAge === null ? undefined : knownAge ? "yes" : "no", className: "acct-age" });
      if (knownAge !== null) age.fs.hidden = true; // answered at setup; the server keeps that answer
      consent = checkbox(self ? STUDENT_CONSENT : SIBLING_CONSENT);
      parentEmail = textField(self ? "Your parent's or guardian's email" : "Their parent's or guardian's email",
        { type: "email", autocomplete: "off", maxlength: "254" },
        "We'll email them to approve. Until then, progress stays on this device.");
      const sync = () => {
        const v = age.value();
        consent.wrap.hidden = v !== "yes";
        parentEmail.wrap.hidden = v !== "no";
      };
      age.inputs.forEach((i) => i.addEventListener("change", sync));
      sync();
      ageBlock.append(age.fs, parentEmail.wrap);
    }

    const err = errorLine();
    const status = statusLine();
    const buttons = parent
      ? [primary("Save and add another", { value: "another" }), primary("Done, start practising", { value: "done", class: "acct-secondary" })]
      : [primary(self ? "Start practising" : "Add student", { value: "done" })];
    const form = h("form", { class: "acct-form", novalidate: true },
      first.wrap, last.wrap, level.fs, colour.fs, ageBlock, consent.wrap, err, status,
      h("div", { class: "acct-actions" }, ...buttons));

    function reset() {
      form.reset();
      colour.inputs[0].checked = true;
      updateSwatches();
      first.input.focus();
    }

    async function submit(intent) {
      err.show("");
      const firstName = first.input.value.trim();
      const lastName = last.input.value.trim();
      if (parent && intent === "done" && saved > 0 && !firstName && !lastName) return finishParent();
      if (!firstName || !lastName) return err.show("Enter a first name and a last name.");
      if (!level.value()) return err.show(self ? "Choose what you're studying for." : "Choose what they're studying for.");
      const body = { firstName, lastName, level: level.value(), colour: colour.value() };
      let over13 = true;
      if (!parent) {
        if (!age.value()) return err.show(self ? "Tell us if you're 13 or older." : "Tell us if they're 13 or older.");
        over13 = age.value() === "yes";
        if (!self) body.over13 = over13;
      }
      if (over13) {
        if (!consent.input.checked) return err.show("Tick the box to agree before saving.");
        body.consent = true;
      } else {
        const email = parentEmail.input.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err.show("Enter your parent's or guardian's email.");
        if (email.toLowerCase() === me.account.email) return err.show("Use a parent's or guardian's email, not this one.");
        body.parentEmail = email;
      }
      if (self && me.account.type === null) {
        const s = await api("/setup", { type: "student", holderOver13: over13 });
        if (!s.ok && errorCode(s) !== "bad_request") return err.show(messageFor(s));
        me.account.type = "student";
        me.account.holderOver13 = over13;
      }
      const r = parent
        ? await ctx.withParentUnlock(() => api("/profiles/create", body))
        : await api("/profiles/create", body);
      if (!r.ok) {
        if (errorCode(r) === "parent_locked") return err.show("Enter the parent code to add a student.");
        if (errorCode(r) === "forbidden" && !parent) return err.show("Only account holders who are 13 or older can add another student.");
        if (r.status === 401) return ctx.handleAuthFailure(r);
        return err.show(messageFor(r));
      }
      const profile = { ...r.data.profile, access: "owner" };
      me.profiles = [...me.profiles.filter((p) => p.id !== profile.id), profile];
      me.account.setupComplete = true;
      saved += 1;
      if (parent && intent === "another") {
        reset();
        status.show(`Saved ${profile.firstName}. Add another child, or choose Done.`);
        return undefined;
      }
      if (parent) return finishParent();
      d.close();
      return ctx.chooseProfile(profile);
    }

    async function finishParent() {
      d.close();
      await ctx.refreshMe();
      openPicker();
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const btn = e.submitter ?? buttons.at(-1);
      busy(btn, () => submit(btn.value));
    });

    d.render(
      h("p", { class: "acct-kicker" }, parent ? "Parent" : self ? "Student" : "New student"),
      h("h2", {}, parent ? "Add your child" : self ? "Tell us about you" : "Add a student"),
      form,
    );
  }

  // ---- Who's practising? ----

  function openPicker() {
    const d = openDialog();
    const grid = h("div", { class: "acct-tiles" });
    for (const p of ctx.selectable()) {
      const waiting = p.consentStatus === "awaiting_parent";
      const name = `${p.firstName} ${p.lastName}`;
      grid.append(h("button", {
        type: "button", class: "acct-tile",
        "aria-label": `${name}, ${levelLabel(p.level)}${waiting ? ", waiting for a parent to approve" : ""}`,
        "aria-current": state.profile?.id === p.id ? "true" : false,
        on: { click: () => { d.close(); ctx.chooseProfile(p); } },
      },
      h("span", { class: "acct-tile-av", style: `--acct-colour:${p.colour}`, "aria-hidden": "true" }, initials(p.firstName, p.lastName)),
      h("span", { class: "acct-tile-name" }, p.firstName),
      h("small", {}, waiting ? "Waiting for parent" : levelLabel(p.level))));
    }
    grid.append(h("button", {
      type: "button", class: "acct-tile acct-tile-add", "aria-label": "Add a student",
      on: { click: () => addStudent(d) },
    }, h("span", { class: "acct-tile-av", "aria-hidden": "true" }, "+"), h("span", { class: "acct-tile-name" }, "Add a student")));
    d.render(
      h("h2", {}, "Who's practising?"),
      ctx.selectable().length ? null : h("p", { class: "acct-sub" }, ctx.isParent()
        ? "Add a child to practise as them on this device."
        : "Add a student to start saving progress."),
      grid,
      ctx.isParent() ? link("See how everyone is doing", () => { d.close(); ctx.openParentSection(); }, { class: "acct-link acct-wide" }) : null,
    );
  }

  async function addStudent(picker) {
    if (ctx.isParent()) {
      const r = await ctx.withParentUnlock(async () => (state.me.parentUnlocked
        ? { ok: true }
        : { ok: false, status: 403, data: { error: "parent_locked" } }));
      if (!r.ok) return;
      picker.close();
      openProfileForm("parent");
      return;
    }
    if (state.me.account.holderOver13 === false) {
      showNotice("Ask a parent or guardian to add another student.");
      return;
    }
    picker.close();
    openProfileForm("student-sibling");
  }

  // ---- Parent unlock (reused by the parent section) ----

  function runParentUnlock() {
    return new Promise((resolve) => {
      let done = false;
      const d = openDialog({ onClose: () => { if (!done) resolve(false); } });
      const code = textField("6-digit code", {
        inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", class: "acct-input acct-code",
      });
      const err = errorLine();
      const status = statusLine();
      const unlock = primary("Unlock");
      const send = async () => {
        const r = await api("/parent/unlock/start");
        if (!r.ok) err.show(messageFor(r));
        return r.ok;
      };
      const form = h("form", { class: "acct-form", novalidate: true }, code.wrap, err, status,
        h("div", { class: "acct-actions" }, unlock, secondary("Cancel", () => d.close())));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(unlock, async () => {
          const value = code.input.value.replace(/\s/g, "");
          if (!/^\d{6}$/.test(value)) return err.show("Enter the 6 numbers from the email.");
          const r = await api("/parent/unlock/verify", { code: value });
          if (!r.ok) return err.show(messageFor(r));
          state.me.parentUnlocked = true;
          done = true;
          d.close();
          resolve(true);
        });
      });
      const again = link("Send a new code", () => busy(again, async () => {
        err.show("");
        if (await send()) status.show("We sent a new code. Use the newest one.");
      }));
      d.render(
        h("p", { class: "acct-kicker" }, "Parent section"),
        h("h2", {}, "We've emailed you a code"),
        h("p", { class: "acct-sub" }, `Enter the code we sent to ${ctx.maskEmail(state.me?.account?.email ?? "")} to continue. It works for 10 minutes.`),
        form,
        h("div", { class: "acct-links" }, again),
      );
      send();
    });
  }

  // ---- Merge prompt ----

  function offerMerge(p) {
    const d = openDialog();
    const err = errorLine();
    const add = h("button", { type: "button", class: "acct-primary", "data-autofocus": true }, "Add");
    add.addEventListener("click", () => busy(add, async () => {
      const r = await ctx.mergeInto(p);
      if (r.ok) {
        d.close();
        showNotice(`Progress on this device was added to ${p.firstName}'s profile.`);
      } else if (!ctx.handleAuthFailure(r, p.id)) {
        err.show(errorCode(r) === "bad_request"
          ? "The progress on this device couldn't be added."
          : messageFor(r));
      }
    }));
    d.render(
      h("h2", {}, `Add the progress on this device to ${p.firstName}'s profile?`),
      h("p", { class: "acct-sub" }, "This is practice done on this device while nobody was signed in. Choose Not mine if someone else did it."),
      err,
      h("div", { class: "acct-actions" }, add, secondary("Not mine", () => d.close("declined"))),
    );
    return d.closed;
  }

  // ---- Parent consent for an under-13 student ----

  function showConsent(c) {
    const d = openDialog();
    const agree = checkbox(PARENT_CONSENT);
    const err = errorLine();
    const name = `${c.firstName} ${c.lastName}`;
    const respond = (approve) => async (e) => busy(e.currentTarget, async () => {
      err.show("");
      if (approve && !agree.input.checked) return err.show("Tick the box to approve.");
      const r = await ctx.withParentUnlock(() => api("/consent/respond", { profileId: c.profileId, approve }));
      if (!r.ok) {
        if (r.status === 401) return ctx.handleAuthFailure(r);
        if (errorCode(r) === "parent_locked") return err.show(messageFor(r));
        if (errorCode(r) === "parent_email_is_student") return err.show("This email is set up as a student account, so it can't approve.");
        if (errorCode(r) === "forbidden") return err.show("This request is no longer waiting for an answer.");
        return err.show(messageFor(r));
      }
      d.close();
      showNotice(approve
        ? `You approved ${c.firstName}. Their practice progress will be saved.`
        : `You declined. ${c.firstName}'s profile has been deleted.`);
      await ctx.refreshMe();
      await ctx.route({ showPicker: true });
      return undefined;
    });
    d.render(
      h("p", { class: "acct-kicker" }, "Parent or guardian approval"),
      h("h2", {}, `${name} wants to use SumDeTing`),
      h("p", { class: "acct-sub" }, "Approve saving their practice progress? SumDeTing keeps only their name, level, colour and practice progress."),
      agree.wrap,
      err,
      h("div", { class: "acct-actions" },
        h("button", { type: "button", class: "acct-primary", on: { click: respond(true) } }, "Approve"),
        h("button", { type: "button", class: "acct-secondary", on: { click: respond(false) } }, "Decline")),
      h("p", { class: "acct-small" }, `If you decline, ${c.firstName}'s profile is deleted.`),
    );
  }

  // ---- A parent asks to see a student's progress ----

  function showRequest(req) {
    const d = openDialog();
    const err = errorLine();
    const eligible = (state.me?.profiles ?? []).filter((p) => p.access === "owner" && p.consentStatus === "active");
    const ticks = eligible.map((p) => {
      const c = checkbox(`${p.firstName} ${p.lastName}`);
      c.input.checked = true;
      c.input.value = p.id;
      return c;
    });
    const finish = () => {
      state.me.pendingRequests = (state.me.pendingRequests ?? []).filter((r) => r.inviteId !== req.inviteId);
    };
    const respond = (allow) => (e) => busy(e.currentTarget, async () => {
      err.show("");
      const profileIds = eligible.length === 1 ? [eligible[0].id] : ticks.filter((t) => t.input.checked).map((t) => t.input.value);
      if (allow && !profileIds.length) return err.show("Tick at least one profile, or choose Decline.");
      const r = await api("/links/respond", { inviteId: req.inviteId, allow, profileIds: allow ? profileIds : [] });
      if (!r.ok && errorCode(r) !== "not_found") {
        if (r.status === 401) return ctx.handleAuthFailure(r, null);
        return err.show(messageFor(r));
      }
      finish();
      d.close();
      if (r.ok) showNotice(allow ? `${req.parentEmail} can now see your progress.` : "Request declined.");
      return undefined;
    });
    d.render(
      h("h2", {}, `${req.parentEmail} wants to see your progress`),
      h("p", { class: "acct-sub" }, "If you allow it, they can see your practice progress. They can't see your chats or practise as you."),
      eligible.length > 1
        ? h("fieldset", { class: "acct-fieldset" }, h("legend", {}, "Which profiles can they see?"), ...ticks.map((t) => t.wrap))
        : null,
      eligible.length === 0 ? h("p", { class: "acct-small" }, "Your profile needs a parent's approval before it can be shared.") : null,
      err,
      h("div", { class: "acct-actions" },
        h("button", { type: "button", class: "acct-primary", disabled: eligible.length === 0, on: { click: respond(true) } }, "Allow"),
        h("button", { type: "button", class: "acct-secondary", on: { click: respond(false) } }, "Decline")),
    );
    return d.closed;
  }

  // ---- Profile menu ----

  function openProfileMenu() {
    const d = openDialog();
    const p = state.profile;
    const me = state.me;
    const item = (text, fn) => h("button", { type: "button", class: "acct-menu-item", on: { click: fn } }, text);
    const items = [item("Switch student", () => { d.close(); openPicker(); })];
    if (me.account.type === "student" && p?.access === "owner" && p.consentStatus === "active") {
      items.push(item("Share my progress with a parent", () => { d.close(); openShare(p); }));
    }
    if (p && (p.access === "owner" || p.access === "guardian")) {
      items.push(item("Who can see my progress", () => { d.close(); openWhoCanSee(p); }));
    }
    if (ctx.isParent()) items.push(item("See how everyone is doing", () => { d.close(); ctx.openParentSection(); }));
    items.push(item("Sign out", () => busy(items.at(-1), async () => { await ctx.signOut(); })));
    d.render(
      h("h2", {}, p ? `${p.firstName} ${p.lastName}` : "Your account"),
      h("p", { class: "acct-sub" }, `Signed in as ${me.account.email}`),
      h("div", { class: "acct-menu" }, ...items),
      h("div", { class: "acct-actions" }, secondary("Close", () => d.close())),
    );
  }

  function openShare(p) {
    const d = openDialog();
    const email = textField("Parent's or guardian's email", { type: "email", autocomplete: "off", maxlength: "254", required: true },
      "They'll get an email with a link to see your practice progress.");
    const err = errorLine();
    const status = statusLine();
    const send = primary("Share");
    const form = h("form", { class: "acct-form", novalidate: true }, email.wrap, err, status,
      h("div", { class: "acct-actions" }, send, secondary("Close", () => d.close())));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(send, async () => {
        err.show("");
        const value = email.input.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return err.show("Enter an email address, like name@example.com.");
        const r = await api("/links/share", { profileId: p.id, parentEmail: value });
        if (r.ok) {
          status.show(`We've emailed ${value}. They can sign in to see your progress.`);
          email.input.value = "";
        } else if (r.status === 401) ctx.handleAuthFailure(r);
        else err.show(messageFor(r));
        return undefined;
      });
    });
    d.render(h("h2", {}, "Share my progress with a parent"), form);
  }

  async function openWhoCanSee(p) {
    const r = await ctx.withParentUnlock(() => api("/links/list", { profileId: p.id }));
    if (!r.ok) {
      if (errorCode(r) !== "parent_locked" && !ctx.handleAuthFailure(r, p.id)) showNotice(messageFor(r));
      return;
    }
    const d = openDialog();
    const err = errorLine();
    const list = h("ul", { class: "acct-people" });
    const people = r.data?.people ?? [];
    for (const person of people) {
      const label = person.kind === "guardian" ? "Guardian" : person.kind === "owner" ? "Owner" : "View only";
      const row = h("li", {}, h("span", {}, h("b", {}, person.email), h("small", {}, label)));
      if (person.removable) {
        const stop = h("button", { type: "button", class: "acct-secondary" }, "Stop sharing");
        stop.addEventListener("click", () => busy(stop, async () => {
          const out = await ctx.withParentUnlock(() => api("/links/remove", { profileId: p.id, accountId: person.accountId }));
          if (out.ok) row.remove();
          else err.show(messageFor(out));
          if (!list.children.length) list.replaceWith(h("p", { class: "acct-sub" }, "Only you can see this progress."));
        }));
        row.append(stop);
      }
      list.append(row);
    }
    d.render(
      h("h2", {}, "Who can see my progress"),
      people.length ? list : h("p", { class: "acct-sub" }, "Only you can see this progress."),
      err,
      h("div", { class: "acct-actions" }, secondary("Close", () => d.close(), { "data-autofocus": true })),
    );
  }

  return {
    openSignin: () => openSignin(), checkSignedInElsewhere, showSetup, openProfileForm, openPicker,
    runParentUnlock, offerMerge, showConsent, showRequest, openProfileMenu,
  };
}
