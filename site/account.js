/* Agent Alla — personal cabinet.
   Talks only to the site's own worker: /api/account, /api/auth/*,
   /api/billing/*. No third-party script, no analytics, no key in the page.

   Three states:
     • the endpoint is not there / billing is off  -> "not switched on yet"
     • signed out                                  -> sign in / create account
     • signed in                                   -> plan, usage, invoices
*/
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var subtitle = $("subtitle");
  var authBox = $("auth"), overview = $("overview"), plans = $("plans"), offline = $("offline");
  var authForm = $("auth-form"), authMsg = $("auth-msg"), authSubmit = $("auth-submit");
  var tabLogin = $("tab-login"), tabSignup = $("tab-signup");
  var acctMsg = $("acct-msg");
  var mode = "login";
  var current = null;

  function show(el, on) { if (el) el.hidden = !on; }
  function say(el, text, bad) {
    if (!el) return;
    el.textContent = text || "";
    el.className = "msg" + (text ? (bad ? " bad" : " ok") : "");
  }

  function money(n) {
    return "€" + (Math.round(n * 100) / 100).toFixed(2);
  }
  function date(sec) {
    if (!sec) return "—";
    try { return new Date(sec * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
    catch (e) { return "—"; }
  }

  var PLAN_NAME = { standard: "Standard", pro: "Pro / Group / Agency" };

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "same-origin";
    if (opts.body) opts.headers = { "content-type": "application/json" };
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        return { status: r.status, ok: r.ok, body: b };
      });
    });
  }

  // ---------------------------------------------------------------- render

  function render(a) {
    // The whole cabinet only makes sense once the billing layer is live.
    if (!a || a.billingEnabled === false) {
      subtitle.textContent = "Alla is open to everyone right now.";
      show(offline, true);
      return;
    }

    if (!a.signedIn) {
      subtitle.textContent = "Sign in to see your plan and your usage.";
      show(authBox, true);
      return;
    }

    subtitle.textContent = "Your plan, your usage and your invoices.";
    show(overview, true);

    current = a;
    $("v-name").textContent = a.name || "Not set";
    $("v-email").textContent = a.email || "—";

    if (a.plan) {
      $("v-plan").textContent = PLAN_NAME[a.plan] || a.plan;
      $("v-status").textContent = (a.status || "").replace(/^./, function (c) { return c.toUpperCase(); }) || "—";
      if (a.currentPeriodEnd) {
        $("v-renews").textContent = date(a.currentPeriodEnd);
        show($("row-renews"), true);
      }
      $("v-autopay").textContent = a.autopay
        ? "Keeps going, billed as used"
        : "Pauses until the next period";
      show($("row-autopay"), true);

      var used = Number(a.usageEur || 0), cap = Number(a.allowanceEur || 0);
      $("k-usage").textContent = "Included usage";
      $("v-usage").textContent = cap ? money(used) + " of " + money(cap) : money(used);
      $("meter-bar").style.width = cap ? Math.min(100, (used / cap) * 100).toFixed(1) + "%" : "0%";
      $("usage-note").textContent = cap && used >= cap
        ? (a.autopay
            ? "You are past the included allowance; further use is billed on your next invoice."
            : "You are at the included allowance. Turn on pay-as-you-go in the billing portal to continue before the period resets.")
        : "The allowance covers Alla's own running cost, not a message count — short questions barely move it.";
      show($("usage-wrap"), true);

      var mine = document.querySelector('.plan[data-plan="' + a.plan + '"]');
      if (mine) mine.setAttribute("data-current", "");
      if (a.status !== "active" && a.status !== "trialing") show(plans, true);
    } else if (a.trial) {
      $("v-plan").textContent = "Free trial";
      var left = Math.max(0, (a.trial.messagesLimit || 0) - (a.trial.messagesUsed || 0));
      $("v-status").textContent = left + " of " + a.trial.messagesLimit + " messages left";
      $("k-usage").textContent = "Trial";
      $("v-usage").textContent = a.trial.messagesUsed + " of " + a.trial.messagesLimit + " messages";
      $("meter-bar").style.width =
        Math.min(100, ((a.trial.messagesUsed || 0) / (a.trial.messagesLimit || 1)) * 100).toFixed(1) + "%";
      $("usage-note").textContent = "The trial runs for " + a.trial.days +
        " days or " + a.trial.messagesLimit + " messages, whichever comes first.";
      show($("usage-wrap"), true);
      show(plans, true);
    } else {
      $("v-plan").textContent = "No plan";
      $("v-status").textContent = "—";
      show(plans, true);
    }
  }

  function load() {
    return api("/api/account").then(function (r) {
      if (!r.ok) throw new Error("unavailable");
      return r.body;
    });
  }

  // ------------------------------------------------------------------ auth

  function setMode(m) {
    mode = m;
    var login = m === "login";
    tabLogin.setAttribute("aria-selected", String(login));
    tabSignup.setAttribute("aria-selected", String(!login));
    authSubmit.textContent = login ? "Sign in" : "Create the account";
    $("password").setAttribute("autocomplete", login ? "current-password" : "new-password");
    // The name is only asked for when creating an account; signing in doesn't
    // need it, and it can be set or changed later from this same page.
    show($("name-field"), !login);
    say(authMsg, "");
  }
  tabLogin.addEventListener("click", function () { setMode("login"); });
  tabSignup.addEventListener("click", function () { setMode("signup"); });

  var AUTH_ERRORS = {
    invalid_credentials: "That email and password don't match an account.",
    email_taken: "There is already an account with that email — sign in instead.",
    weak_password: "Use a password of at least 8 characters.",
    bad_email: "That doesn't look like an email address."
  };

  authForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = $("email").value.trim(), password = $("password").value;
    if (!email || !password) return;
    var payload = { email: email, password: password };
    if (mode === "signup") {
      var n = $("name").value.trim();
      if (n) payload.name = n;
    }
    authSubmit.disabled = true;
    say(authMsg, mode === "login" ? "Signing in…" : "Creating your account…");
    api("/api/auth/" + mode, { method: "POST", body: JSON.stringify(payload) })
      .then(function (r) {
        if (r.ok) { location.reload(); return; }
        var key = r.body && r.body.error;
        say(authMsg, AUTH_ERRORS[key] ||
          (r.status === 409 ? AUTH_ERRORS.email_taken
            : r.status === 401 ? AUTH_ERRORS.invalid_credentials
            : r.status === 400 ? AUTH_ERRORS.weak_password
            : "Something went wrong — please try again."), true);
        authSubmit.disabled = false;
      })
      .catch(function () {
        say(authMsg, "Couldn't reach the server — please try again.", true);
        authSubmit.disabled = false;
      });
  });

  // -------------------------------------------------------------- actions

  function closeNameEditor() {
    show($("name-editor"), false);
    show($("name-edit"), true);
  }
  $("name-edit").addEventListener("click", function () {
    $("name-input").value = (current && current.name) || "";
    show($("name-editor"), true);
    show($("name-edit"), false);
    $("name-input").focus();
  });
  $("name-cancel").addEventListener("click", closeNameEditor);
  $("name-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); $("name-save").click(); }
    if (e.key === "Escape") closeNameEditor();
  });
  $("name-save").addEventListener("click", function () {
    var v = $("name-input").value.trim();
    $("name-save").disabled = true;
    api("/api/account/name", { method: "POST", body: JSON.stringify({ name: v }) })
      .then(function (r) {
        $("name-save").disabled = false;
        if (!r.ok) { say(acctMsg, "Couldn't save that name — please try again.", true); return; }
        if (current) current.name = r.body.name || null;
        $("v-name").textContent = (r.body.name) || "Not set";
        closeNameEditor();
        say(acctMsg, "Name updated.");
      })
      .catch(function () {
        $("name-save").disabled = false;
        say(acctMsg, "Couldn't reach the server — please try again.", true);
      });
  });

  $("logout-btn").addEventListener("click", function () {
    api("/api/auth/logout", { method: "POST" }).then(function () { location.reload(); });
  });

  $("portal-btn").addEventListener("click", function () {
    var b = $("portal-btn");
    b.disabled = true;
    say(acctMsg, "Opening the billing portal…");
    api("/api/billing/portal", { method: "POST" }).then(function (r) {
      if (r.ok && r.body.url) { location.href = r.body.url; return; }
      say(acctMsg, r.body && r.body.error === "no_customer"
        ? "There is nothing to show yet — this account has never been billed."
        : "The billing portal isn't available right now.", true);
      b.disabled = false;
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-checkout]"), function (btn) {
    btn.addEventListener("click", function () {
      var plan = btn.getAttribute("data-checkout");
      btn.disabled = true;
      var old = btn.textContent;
      btn.textContent = "Opening checkout…";
      api("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: plan }) })
        .then(function (r) {
          if (r.ok && r.body.url) { location.href = r.body.url; return; }
          say(acctMsg, r.body && r.body.error === "sign_in_required"
            ? "Please sign in first."
            : "Checkout isn't available yet — please try again shortly.", true);
          btn.disabled = false;
          btn.textContent = old;
        });
    });
  });

  // ------------------------------------------------------------- start up

  var q = new URLSearchParams(location.search);
  load()
    .then(function (a) {
      render(a);
      if (q.get("checkout") === "done") say(acctMsg, "Thank you — your subscription is active.");
      if (q.get("checkout") === "cancelled") say(acctMsg, "Checkout was cancelled; nothing was charged.");
    })
    .catch(function () {
      subtitle.textContent = "Alla is open to everyone right now.";
      show(offline, true);
    });
})();
