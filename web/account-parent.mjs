// Parent section (behind the emailed parent code) and account/profile deletion.
// Stateful work (caches, sign-out cleanup) stays in account-ui.mjs and arrives
// through `ctx`. Every user-controlled string is set as text, never as HTML.
import { initials, statusLabel, lastPractisedText } from "./account-core.mjs";
import { nextId } from "./account-dom.mjs";
import { COLOURS, levelLabel, accessLabel } from "./account-screens.mjs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PILL = { hard: "acct-pill-hard", confident: "acct-pill-ok", getting_there: "acct-pill-mid" };
export const DELETED_MSG = "Your account has been deleted.";
export const LOCKED_MSG = "The parent section locked.";

const fullName = (c) => `${c.firstName} ${c.lastName}`;
const canManage = (c) => c.access === "owner" || c.access === "guardian";
const count = (v) => (Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);

export function createParentSection(ctx) {
  const { api, state, h, openDialog, showNotice, busy, errorLine, statusLine, messageFor, errorCode, confirmDanger } = ctx;
  const forms = () => ctx.forms();

  /** Turn a failed result into copy; null when it was already handled (signed out, or the unlock was cancelled). */
  function failure(r, pid = null) {
    if (errorCode(r) === "parent_locked") return null;
    if (ctx.handleAuthFailure(r, pid)) return null;
    return messageFor(r);
  }

  const avatar = (c, cls = "acct-row-av") =>
    h("span", { class: cls, style: `--acct-colour:${c.colour}`, "aria-hidden": "true" }, initials(c.firstName, c.lastName));
  const backButton = (text, onClick) =>
    h("button", { type: "button", class: "acct-back", on: { click: onClick } }, text);
  const heading = (text) => h("h2", { tabindex: "-1", "data-autofocus": true }, text);

  // ---- The section: one sheet, re-rendered for each view ----

  function showOverview(initial, { view } = {}) {
    let children = initial?.children ?? [];
    let timer = null;
    // Closing the section, however it happens, locks it again.
    const d = openDialog({ onClose: () => { clearTimeout(timer); ctx.lockParent(); } });
    const find = (pid) => children.find((c) => c.profileId === pid);
    const drop = (pid) => { children = children.filter((c) => c.profileId !== pid); };

    /** Close the section (and anything stacked on it) so no progress stays on screen once locked. */
    function lock() {
      clearTimeout(timer);
      if (!d.open) return;
      ctx.markLocked();
      ctx.closeFrom(d);
      showNotice(LOCKED_MSG);
    }

    /** Re-lock when the unlock window ends; a fresh unlock meanwhile pushes it back. */
    function schedule() {
      clearTimeout(timer);
      const left = ctx.unlockedUntil() - Date.now();
      if (left <= 0) return lock();
      timer = setTimeout(() => (ctx.unlockedUntil() > Date.now() ? schedule() : lock()), left);
      return undefined;
    }

    /** Like failure(), but a parent_locked that the person didn't unlock closes the section. */
    function fail(r, pid = null) {
      if (errorCode(r) === "parent_locked") { lock(); return null; }
      return failure(r, pid);
    }

    async function reload() {
      const r = await ctx.withParentUnlock(() => api("/parent/overview"));
      if (!r.ok) {
        const msg = fail(r);
        if (msg) showNotice(msg);
        return false;
      }
      children = r.data?.children ?? [];
      return true;
    }

    function list(notice) {
      const status = statusLine();
      const rows = h("ul", { class: "acct-kids" });
      for (const c of children) {
        rows.append(h("li", {}, h("button", { type: "button", class: "acct-kid", on: { click: () => child(c.profileId) } },
          avatar(c),
          h("span", { class: "acct-kid-text" },
            h("b", {}, fullName(c)),
            h("small", {}, levelLabel(c.level))),
          h("span", { class: `acct-tag acct-tag-${c.access}` }, accessLabel(c.access)))));
      }
      d.render(
        h("p", { class: "acct-kicker" }, "Parent section"),
        heading("See how everyone is doing"),
        h("p", { class: "acct-sub" }, "Practice progress for each student. Chats are never shown."),
        children.length ? rows : h("p", { class: "acct-sub" }, "No students yet."),
        status,
        h("div", { class: "acct-actions" },
          forms().secondary("Add a child who has their own account", () => request()),
          forms().secondary("Close", () => d.close())),
        h("div", { class: "acct-links" },
          forms().link("Delete account", () => openDeleteAccount(), { class: "acct-link acct-link-danger" })),
      );
      if (notice) status.show(notice);
    }

    function child(pid, notice) {
      const c = find(pid);
      if (!c) return list();
      const s = c.summary ?? {};
      const stat = (n, label) => h("div", { class: "acct-stat" }, h("b", {}, String(count(n))), h("span", {}, label));
      const group = (title, topics) => {
        if (!topics?.length) return null;
        const id = nextId("acct-grp");
        return h("section", { class: "acct-group", "aria-labelledby": id },
          h("h3", { id }, title),
          ...topics.map(topicRow));
      };
      const groups = [group("Needs practice", s.needsPractice), group("Going well", s.goingWell)].filter(Boolean);
      const status = statusLine();
      const actions = [];
      if (canManage(c)) {
        const { secondary } = forms();
        actions.push(
          secondary("Edit", () => edit(pid)),
          secondary("Add another parent or guardian", () => invite(pid)),
          secondary("Who can see this child's progress", (e) => busy(e.currentTarget, () => people(pid))),
        );
        if (c.access === "owner") {
          const remove = h("button", { type: "button", class: "acct-secondary acct-secondary-danger" }, "Remove child");
          remove.addEventListener("click", () => busy(remove, () => removeChild(pid, status)));
          actions.push(remove);
        }
      }
      if (c.access !== "owner") {
        const stop = h("button", { type: "button", class: "acct-secondary acct-secondary-danger" }, `Stop seeing ${c.firstName}'s progress`);
        stop.addEventListener("click", () => busy(stop, () => stopSeeing(pid, status)));
        actions.push(stop);
      }
      d.render(
        backButton("All students", () => list()),
        h("div", { class: "acct-who" },
          avatar(c, "acct-who-av"),
          h("div", {},
            heading(fullName(c)),
            h("p", { class: "acct-who-meta" },
              h("span", {}, levelLabel(c.level)),
              h("span", { "aria-hidden": "true" }, " · "),
              h("span", {}, lastPractisedText(s.lastPractised))))),
        h("div", { class: "acct-stats" },
          stat(s.streak, "day streak"), stat(s.solved, "problems solved"), stat(s.topicsTried, "topics tried")),
        groups.length ? groups : h("p", { class: "acct-sub" }, "No practice yet."),
        status,
        actions.length ? h("div", { class: "acct-actions acct-child-actions" }, ...actions) : null,
      );
      if (notice) status.show(notice);
    }

    function topicRow(t) {
      const solved = count(t.solved);
      const attempted = count(t.attempted);
      const pct = attempted ? Math.min(100, Math.round((solved / attempted) * 100)) : 0;
      const meta = [`${solved} of ${attempted} solved`];
      if (t.hintsOften) meta.push("often needed hints");
      const label = statusLabel(t.status);
      return h("div", { class: "acct-topic" },
        h("div", { class: "acct-topic-top" },
          h("b", {}, String(t.name ?? "")),
          label ? h("span", { class: `acct-pill ${PILL[t.status] ?? ""}` }, label) : null),
        h("div", { class: "acct-bar", "aria-hidden": "true" }, h("i", { style: `width:${pct}%` })),
        h("p", { class: "acct-topic-meta" }, meta.join(" · ")));
    }

    // ---- Edit a child ----

    function edit(pid) {
      const c = find(pid);
      if (!c) return list();
      const { textField, radioGroup, primary } = forms();
      const first = textField("First name or nickname", { maxlength: "40", autocomplete: "off", value: c.firstName });
      const last = textField("Last name", { maxlength: "40", autocomplete: "off", value: c.lastName });
      const group = nextId("acct-g");
      const level = radioGroup("What are they studying for?", `${group}-level`,
        ctx.SD.levels.map((l) => ({ value: l, label: levelLabel(l) })), { checked: c.level, className: "acct-levels" });
      const colour = radioGroup("Pick a colour", `${group}-colour`,
        COLOURS.map(([hex, name]) => ({
          value: hex, ariaLabel: name, style: `--acct-colour:${hex}`,
          content: h("span", { class: "acct-swatch", "aria-hidden": "true" }, initials(c.firstName, c.lastName)),
        })), { checked: COLOURS.some(([hex]) => hex === c.colour) ? c.colour : undefined, className: "acct-colours" });
      const err = errorLine();
      const save = primary("Save");
      const form = h("form", { class: "acct-form", novalidate: true },
        first.wrap, last.wrap, level.fs, colour.fs, err,
        h("div", { class: "acct-actions" }, save));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(save, async () => {
          err.show("");
          const firstName = first.input.value.trim();
          const lastName = last.input.value.trim();
          if (!firstName || !lastName) return err.show("Enter a first name and a last name.");
          const body = { profileId: pid, firstName, lastName, level: level.value() ?? c.level };
          if (colour.value()) body.colour = colour.value();
          const r = await ctx.withParentUnlock(() => api("/profiles/update", body));
          if (!r.ok) {
            const msg = fail(r);
            if (msg) err.show(msg);
            return undefined;
          }
          ctx.profileChanged(r.data.profile);
          const saved = r.data?.profile ?? {};
          children = children.map((x) => (x.profileId === pid ? {
            ...x,
            firstName: saved.firstName ?? body.firstName,
            lastName: saved.lastName ?? body.lastName,
            level: saved.level ?? body.level,
            colour: saved.colour ?? body.colour ?? x.colour,
          } : x));
          await reload();
          return d.open ? child(pid, "Saved.") : undefined;
        });
      });
      d.render(backButton("Back", () => child(pid)), heading(`Edit ${c.firstName}`), form);
    }

    // ---- Second guardian ----

    function invite(pid) {
      const c = find(pid);
      if (!c) return list();
      const { textField, primary } = forms();
      const email = textField("Email", { type: "email", autocomplete: "off", maxlength: "254", required: true });
      const err = errorLine();
      const status = statusLine();
      const send = primary("Send invite");
      const form = h("form", { class: "acct-form", novalidate: true }, email.wrap, err, status,
        h("div", { class: "acct-actions" }, send));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(send, async () => {
          err.show("");
          status.show("");
          const value = email.input.value.trim();
          if (!EMAIL_RE.test(value)) return err.show("Enter an email address, like name@example.com.");
          if (value.toLowerCase() === state.me?.account?.email) return err.show("Use the other parent's or guardian's email, not yours.");
          const r = await ctx.withParentUnlock(() => api("/links/invite-guardian", { profileId: pid, email: value }));
          if (r.ok) {
            email.input.value = "";
            return status.show(`We've emailed ${value}. Once they sign in, ${c.firstName} appears on their Who's practising? screen.`);
          }
          const code = errorCode(r);
          if (code === "already_linked") return err.show(`That person can already see ${c.firstName}'s progress.`);
          if (code === "bad_request") return err.show("Check the email and try again.");
          const msg = fail(r);
          if (msg) err.show(msg);
          return undefined;
        });
      });
      d.render(
        backButton("Back", () => child(pid)),
        heading("Add another parent or guardian"),
        h("p", { class: "acct-sub" }, `They'll get an email with a sign-in link. Once signed in, they can practise as ${c.firstName} on their own devices, see ${c.firstName}'s progress and edit ${c.firstName}'s profile.`),
        form,
      );
    }

    // ---- Who can see this child's progress ----

    async function people(pid) {
      const c = find(pid);
      if (!c) return list();
      const r = await ctx.withParentUnlock(() => api("/links/list", { profileId: pid }));
      if (!r.ok) {
        const msg = fail(r);
        if (msg) showNotice(msg);
        return undefined;
      }
      const err = errorLine();
      const status = statusLine();
      const none = () => h("p", { class: "acct-sub" }, `Only you can see ${c.firstName}'s progress.`);
      const rows = h("ul", { class: "acct-people" });
      for (const person of r.data?.people ?? []) {
        const row = h("li", {}, h("span", {}, h("b", {}, person.email), h("small", {}, accessLabel(person.kind))));
        if (person.removable) {
          const remove = h("button", { type: "button", class: "acct-secondary acct-secondary-danger", "aria-label": `Remove ${person.email}` }, "Remove");
          remove.addEventListener("click", () => busy(remove, async () => {
            err.show("");
            const sure = await confirmDanger({
              title: `Remove ${person.email}'s access?`,
              lines: [person.kind === "guardian"
                ? `They will no longer be able to practise as ${c.firstName} or see ${c.firstName}'s progress.`
                : `They will no longer be able to see ${c.firstName}'s progress.`],
              action: "Remove access",
            });
            if (!sure) return;
            const out = await ctx.withParentUnlock(() => api("/links/remove", { profileId: pid, accountId: person.accountId }));
            if (!out.ok) {
              const msg = fail(out);
              if (msg) err.show(msg);
              return;
            }
            row.remove();
            status.show(`${person.email} can no longer see ${c.firstName}'s progress.`);
            if (!rows.children.length) rows.replaceWith(none());
          }));
          row.append(remove);
        }
        rows.append(row);
      }
      d.render(
        backButton("Back", () => child(pid)),
        heading(`Who can see ${c.firstName}'s progress`),
        rows.children.length ? rows : none(),
        err, status,
      );
      return undefined;
    }

    async function removeChild(pid, status) {
      const c = find(pid);
      if (!c) return;
      const sure = await confirmDanger({
        title: `Remove ${fullName(c)}?`,
        lines: [
          `This deletes ${c.firstName}'s profile and all of ${c.firstName}'s practice progress, on every device.`,
          `Anyone else who can see ${c.firstName}'s progress loses access too.`,
        ],
        action: "Remove child",
        irreversible: true,
      });
      if (!sure) return;
      const r = await ctx.withParentUnlock(() => api("/profiles/delete", { profileId: pid }));
      if (!r.ok) {
        const msg = fail(r);
        if (msg) status.show(msg);
        return;
      }
      ctx.profileRemoved(pid);
      drop(pid);
      await reload();
      if (d.open) list(`${fullName(c)} has been removed.`);
    }

    /** A guardian or view-only parent ends their own access to this child. */
    async function stopSeeing(pid, status) {
      const c = find(pid);
      const self = state.me?.account?.id;
      if (!c || !self) return;
      const sure = await confirmDanger({
        title: `Stop seeing ${c.firstName}'s progress?`,
        lines: [c.access === "guardian"
          ? `You will no longer be able to practise as ${c.firstName} or see ${c.firstName}'s progress. Another parent or guardian can invite you again.`
          : `You will no longer see ${c.firstName}'s progress. ${c.firstName} can share it with you again.`],
        action: "Stop seeing",
      });
      if (!sure) return;
      const r = await ctx.withParentUnlock(() => api("/links/remove", { profileId: pid, accountId: self }));
      if (!r.ok) {
        const msg = fail(r);
        if (msg) status.show(msg);
        return;
      }
      ctx.profileRemoved(pid);
      drop(pid);
      await reload();
      if (d.open) list(`You no longer see ${c.firstName}'s progress.`);
    }

    // ---- A child who has their own account ----

    function request() {
      const { textField, primary } = forms();
      const email = textField("Child's email", { type: "email", autocomplete: "off", maxlength: "254", required: true },
        "The email your child signs in to SumDeTing with.");
      const err = errorLine();
      const status = statusLine();
      const send = primary("Send request");
      const form = h("form", { class: "acct-form", novalidate: true }, email.wrap, err, status,
        h("div", { class: "acct-actions" }, send));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        busy(send, async () => {
          err.show("");
          status.show("");
          const value = email.input.value.trim();
          if (!EMAIL_RE.test(value)) return err.show("Enter an email address, like name@example.com.");
          if (value.toLowerCase() === state.me?.account?.email) return err.show("Use your child's email, not yours.");
          const r = await ctx.withParentUnlock(() => api("/links/request", { childEmail: value }));
          if (r.ok) {
            email.input.value = "";
            return status.show(`We've emailed ${value}. Their progress appears here once they allow it.`);
          }
          if (errorCode(r) === "bad_request") return err.show("Check the email and try again.");
          const msg = fail(r);
          if (msg) err.show(msg);
          return undefined;
        });
      });
      d.render(
        backButton("Back", () => list()),
        heading("Add a child who has their own account"),
        h("p", { class: "acct-sub" }, "If your child already uses SumDeTing with their own email, ask to see their progress. They'll get an email and need to allow it. You'll see their progress, but you can't practise as them or change their profile."),
        form,
      );
    }

    if (view === "request") request();
    else list();
    schedule();
    return d;
  }

  // ---- Deleting ----

  /** Owned profiles, for naming exactly what a delete removes. */
  const ownedNames = () => (state.me?.profiles ?? []).filter((p) => p.access === "owner").map(fullName);

  async function openDeleteAccount() {
    const me = state.me;
    if (!me) return;
    const names = ownedNames();
    const parent = me.account.type === "parent";
    const lines = [`This deletes the SumDeTing account for ${me.account.email}.`];
    if (names.length) {
      lines.push(names.length === 1
        ? "It also deletes this profile and all of its practice progress:"
        : "It also deletes these profiles and all of their practice progress:");
    }
    const others = (me.profiles ?? []).some((p) => p.access !== "owner");
    const after = names.length ? ["Anyone else who could see these profiles loses access too."] : [];
    if (others) after.push("Students you can see but didn't add keep their own profiles.");
    const sure = await confirmDanger({
      title: "Delete your account?",
      lines,
      items: names,
      after,
      action: "Delete account",
      irreversible: true,
    });
    if (!sure) return;
    if (parent || me.account.type === null) {
      const r = await ctx.withParentUnlock(() => api("/account/delete", {}));
      if (r.ok) return ctx.accountDeleted();
      const msg = failure(r);
      if (msg) showNotice(msg);
      return;
    }
    await codeThenDelete({
      action: "Delete account",
      what: "delete your account",
      run: (code) => api("/account/delete", { code }),
      done: () => ctx.accountDeleted(),
    });
  }

  /** A student removes one of their sibling profiles (needs the emailed code). */
  async function openRemoveProfile(p) {
    const sure = await confirmDanger({
      title: `Remove ${fullName(p)}?`,
      lines: [`This deletes ${p.firstName}'s profile and all of ${p.firstName}'s practice progress, on every device.`],
      action: "Remove profile",
      irreversible: true,
    });
    if (!sure) return;
    await codeThenDelete({
      action: "Remove profile",
      what: `remove ${p.firstName}'s profile`,
      run: (code) => api("/profiles/delete", { profileId: p.id, code }),
      done: () => {
        ctx.profileRemoved(p.id);
        showNotice(`${fullName(p)}'s profile has been deleted.`);
      },
    });
  }

  /** Email a confirm-delete code (student accounts), ask for it, then run the delete. */
  async function codeThenDelete({ action, what, run, done }) {
    const start = await api("/delete/start");
    if (!start.ok) {
      const msg = failure(start);
      if (msg) showNotice(msg);
      return;
    }
    const { textField, primary, secondary, link } = forms();
    const d = openDialog();
    const code = textField("6-digit code", {
      inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", class: "acct-input acct-code",
    });
    const err = errorLine();
    const status = statusLine();
    const go = primary(action, { class: "acct-primary acct-danger" });
    const form = h("form", { class: "acct-form", novalidate: true }, code.wrap, err, status,
      h("div", { class: "acct-actions" }, go, secondary("Cancel", () => d.close())));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(go, async () => {
        err.show("");
        const value = code.input.value.replace(/\s/g, "");
        if (!/^\d{6}$/.test(value)) return err.show("Enter the 6 numbers from the email.");
        const r = await run(value);
        if (!r.ok) {
          const msg = failure(r);
          if (msg) err.show(msg);
          return undefined;
        }
        d.close();
        return done();
      });
    });
    const again = link("Send a new code", () => busy(again, async () => {
      err.show("");
      const r = await api("/delete/start");
      if (r.ok) status.show("We sent a new code. Use the newest one.");
      else err.show(messageFor(r));
    }));
    d.render(
      h("p", { class: "acct-kicker" }, "Confirm"),
      h("h2", {}, "We've emailed you a code"),
      h("p", { class: "acct-sub" }, `Enter the code we sent to ${ctx.maskEmail(state.me?.account?.email ?? "")} to ${what}. It works for 10 minutes.`),
      form,
      h("div", { class: "acct-links" }, again),
    );
  }

  return { showOverview, openDeleteAccount, openRemoveProfile };
}
