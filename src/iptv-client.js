"use strict";

(function (global) {
  function create(options) {
    options = options || {};
    const byId = id => document.getElementById(id);
    const root = byId("iptv"), setup = byId("iptvSetup"), browser = byId("iptvBrowser"), grid = byId("iptvGrid");
    const sourceName = byId("iptvSourceName"), category = byId("iptvCategory"), search = byId("iptvSearch");
    const more = byId("iptvMore"), back = byId("iptvBack"), kinds = byId("iptvKinds"), errorEl = byId("iptvError");
    let connectMode = "xtream", kind = "live", source = null, categories = { live: [], movie: [], series: [] };
    let cursor = null, loading = false, seriesOpen = false, searchTimer = null, requestId = 0, applyingNav = false, pendingNav = null;

    function t(key) { return options.tr ? options.tr(key) : key; }
    function api(path) { return String(options.base ? options.base() : location.origin).replace(/\/$/, "") + "/iptv" + path; }
    function headers(json) {
      const out = source ? { "X-SameCouch-IPTV": source.token } : {};
      if (json) out["Content-Type"] = "application/json";
      return out;
    }
    function message(text) { grid.innerHTML = ""; const el = document.createElement("div"); el.className = "iptv-msg"; el.textContent = text; grid.appendChild(el); }
    function errorText(code) {
      const key = {
        credentials_required:"iptv_err_fields", playlist_required:"iptv_err_fields", provider_auth:"iptv_err_auth",
        private_address:"iptv_err_blocked", host_not_allowed:"iptv_err_blocked", port_not_allowed:"iptv_err_port",
        source_expired:"iptv_err_expired", room_required:"iptv_err_room", rate_limited:"iptv_err_busy",
        iptv_busy:"iptv_err_busy", playlist_parse:"iptv_err_playlist", dns_failed:"iptv_err_connect",
        bad_url:"iptv_err_url", bad_scheme:"iptv_err_url", url_auth_not_allowed:"iptv_err_url"
      }[code];
      return t(key || "iptv_err_connect");
    }
    async function responseJson(response) {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { const e = new Error(body.error || "iptv_failed"); e.code = body.error || "iptv_failed"; throw e; }
      return body;
    }
    function showSetup() {
      setup.style.display = ""; browser.classList.remove("show"); byId("iptvDisconnect").hidden = true;
      sourceName.textContent = ""; seriesOpen = false; back.style.display = "none"; kinds.style.display = "flex"; category.style.display = ""; search.parentElement.style.display = "flex";
    }
    function showBrowser() {
      setup.style.display = "none"; browser.classList.add("show"); byId("iptvDisconnect").hidden = false;
      sourceName.textContent = source ? source.name : "";
    }
    function setConnectMode(next) {
      connectMode = next === "m3u" ? "m3u" : "xtream";
      document.querySelectorAll("[data-iptv-mode]").forEach(button => button.classList.toggle("active", button.dataset.iptvMode === connectMode));
      byId("iptvXtreamFields").hidden = connectMode !== "xtream"; byId("iptvM3uFields").hidden = connectMode !== "m3u"; errorEl.textContent = "";
    }
    function pickInitialKind() {
      if ((categories.live || []).length) return "live";
      if ((categories.movie || []).length) return "movie";
      if ((categories.series || []).length) return "series";
      return "live";
    }
    function sendNavigation(message) {
      if (!source || applyingNav || !root.classList.contains("show") || !options.send) return;
      options.send(Object.assign({type:"iptv-nav"}, message));
    }
    function catalogNavigation() { sendNavigation({view:"catalog",kind,category:category.value,q:search.value.trim()}); }
    function setKind(next, load, announce) {
      kind = next === "movie" || next === "series" ? next : "live";
      seriesOpen = false; back.style.display = "none"; kinds.style.display = "flex"; category.style.display = ""; search.parentElement.style.display = "flex";
      kinds.querySelectorAll("[data-kind]").forEach(button => button.classList.toggle("active", button.dataset.kind === kind));
      renderCategories(); if (announce !== false) catalogNavigation(); if (load !== false) loadCatalog(false);
    }
    function renderCategories(list) {
      if (list) categories[kind] = list;
      const selected = category.value; category.innerHTML = "";
      const all = document.createElement("option"); all.value = ""; all.textContent = t("iptv_all"); category.appendChild(all);
      (categories[kind] || []).forEach(item => { const option = document.createElement("option"); option.value = item.id; option.textContent = item.title; category.appendChild(option); });
      if ([].some.call(category.options, option => option.value === selected)) category.value = selected;
    }
    function cardFor(item) {
      const card = document.createElement("button"); card.type = "button"; card.className = "iptv-card " + (item.kind === "live" ? "live" : ""); card.dataset.itemId = item.id;
      const art = document.createElement("span"); art.className = "iptv-art"; art.textContent = item.kind === "live" ? "📺" : item.kind === "series" ? "▦" : "▶";
      if (item.image) {
        const image = document.createElement("img"); image.alt = ""; image.loading = "lazy"; image.decoding = "async"; image.referrerPolicy = "no-referrer"; image.src = item.image;
        image.addEventListener("error", () => image.remove()); art.appendChild(image);
      }
      const copy = document.createElement("span"); copy.className = "iptv-card-copy";
      const title = document.createElement("span"); title.className = "iptv-card-title"; title.textContent = item.title;
      if (item.kind === "live") { const badge = document.createElement("span"); badge.className = "iptv-live-badge"; badge.textContent = "LIVE"; title.appendChild(badge); }
      const meta = document.createElement("span"); meta.className = "iptv-card-meta";
      const bits = []; if (item.season != null) bits.push("S" + item.season + (item.episode != null ? " · E" + item.episode : "")); if (item.year) bits.push(item.year); if (item.rating != null) bits.push("★ " + item.rating); meta.textContent = bits.join(" · ");
      copy.appendChild(title); if (bits.length) copy.appendChild(meta); card.appendChild(art); card.appendChild(copy);
      card.addEventListener("click", () => item.kind === "series" ? openSeries(item) : resolve(item)); return card;
    }
    function renderItems(items, append) {
      if (!append) grid.innerHTML = "";
      (items || []).forEach(item => grid.appendChild(cardFor(item)));
      if (!grid.children.length) message(t("iptv_empty"));
    }
    function flushPendingNavigation() { if (!loading && pendingNav && root.classList.contains("show")) { const nav=pendingNav; pendingNav=null; setTimeout(() => applyNavigation(nav), 0); } }
    async function loadCatalog(append) {
      if (!source) return; if (loading) { pendingNav={view:"catalog",kind,category:category.value,q:search.value.trim()}; return; } loading = true; const own = ++requestId;
      if (!append) { cursor = null; message(t("iptv_loading")); }
      more.hidden = true;
      const query = new URLSearchParams({ kind, limit:"60" });
      if (category.value) query.set("category", category.value); if (search.value.trim()) query.set("q", search.value.trim()); if (append && cursor != null) query.set("cursor", String(cursor));
      try {
        const data = await responseJson(await fetch(api("/catalog?") + query.toString(), { headers: headers(false) }));
        if (own !== requestId) return; if (data.source) source = data.source; renderCategories(data.categories || []); renderItems(data.items || [], append); cursor = data.nextCursor; more.hidden = cursor == null;
      } catch (error) {
        if (own !== requestId) return; if (error.code === "source_expired") setSource(null); message(errorText(error.code));
      } finally { if (own === requestId) { loading = false; flushPendingNavigation(); } }
    }
    async function openSeries(item, announce) {
      if (!source) return; if (loading) { pendingNav={view:"series",kind:"series",id:item.id,title:item.title||""}; if (announce !== false) sendNavigation(pendingNav); return; } loading = true; seriesOpen = true; back.style.display = ""; kinds.style.display = "none"; category.style.display = "none"; search.parentElement.style.display = "none"; more.hidden = true; message(t("iptv_loading_episodes"));
      if (announce !== false) sendNavigation({view:"series",kind:"series",id:item.id,title:item.title||""});
      try {
        const data = await responseJson(await fetch(api("/series?id=") + encodeURIComponent(item.id.split(":").slice(1).join(":")), { headers: headers(false) }));
        renderItems(data.items || [], false);
      } catch (error) { message(errorText(error.code)); }
      finally { loading = false; flushPendingNavigation(); }
    }
    async function resolve(item) {
      if (!source || loading) return; loading = true; const old = cardStatus(item.id, t("iptv_opening"));
      try {
        const data = await responseJson(await fetch(api("/resolve"), { method:"POST", headers:headers(true), body:JSON.stringify({ id:item.id }) }));
        if (options.play) options.play(data); close();
      } catch (error) { if (options.toast) options.toast(errorText(error.code), 7000); }
      finally { loading = false; if (old) old(); }
    }
    function cardStatus(id, text) {
      const cards = grid.querySelectorAll(".iptv-card"); let target = null;
      cards.forEach(card => { if (card.dataset.itemId === id) target = card; });
      if (!target) return null; const copy = target.querySelector(".iptv-card-meta"), before = copy ? copy.textContent : ""; target.disabled = true; if (copy) copy.textContent = text;
      return () => { target.disabled = false; if (copy) copy.textContent = before; };
    }
    async function connect() {
      if (loading) return; errorEl.textContent = "";
      const body = { type:connectMode, room:options.room ? options.room() : "", roomKey:options.roomKey ? options.roomKey() : "" };
      if (connectMode === "xtream") { body.server = byId("iptvServer").value.trim(); body.username = byId("iptvUser").value.trim(); body.password = byId("iptvPass").value; }
      else body.playlistUrl = byId("iptvPlaylist").value.trim();
      if (!body.roomKey) { errorEl.textContent = t("iptv_err_room_wait"); return; }
      loading = true; const button = byId("iptvConnect"), old = button.textContent; button.disabled = true; button.textContent = t("iptv_connecting");
      try {
        const data = await responseJson(await fetch(api("/connect"), { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) }));
        byId("iptvPass").value = ""; byId("iptvUser").value = ""; byId("iptvServer").value = ""; byId("iptvPlaylist").value = "";
        categories = data.categories || {live:[],movie:[],series:[]}; setSource(data.source, false); if (options.send) options.send({type:"iptv-source",token:source.token}); loading=false; setKind(pickInitialKind(),false); setTimeout(() => loadCatalog(false),0);
      } catch (error) { errorEl.textContent = errorText(error.code); }
      finally { loading = false; button.disabled = false; button.textContent = old; flushPendingNavigation(); }
    }
    function setSource(next, load) {
      if (!next || !next.token) { source = null; categories = {live:[],movie:[],series:[]}; showSetup(); return; }
      const changed = !source || source.token !== next.token; source = { token:String(next.token), type:String(next.type || "xtream"), name:String(next.name || "IPTV"), expiresAt:+next.expiresAt || 0 };
      showBrowser(); if (changed && load !== false) { categories = {live:[],movie:[],series:[]}; setKind("live",true,false); }
    }
    function applyNavigation(nav) {
      if (!nav || !source) return; if (!root.classList.contains("show") || loading) { pendingNav = nav; return; }
      applyingNav = true;
      if (nav.view === "series" && nav.id) openSeries({id:String(nav.id),kind:"series",title:String(nav.title||"")}, false);
      else { setKind(nav.kind, false, false); category.value = String(nav.category||""); search.value = String(nav.q||""); loadCatalog(false); }
      applyingNav = false;
    }
    function open() { if (!root) return; root.classList.add("show"); source ? showBrowser() : showSetup(); if (source && pendingNav) { const nav=pendingNav; pendingNav=null; applyNavigation(nav); } else if (source && !grid.querySelector(".iptv-card")) loadCatalog(false); }
    function close() { if (root) root.classList.remove("show"); }
    function disconnect() { if (options.send) options.send({type:"iptv-source",token:""}); setSource(null); }
    function localize() {
      const texts = {iptvTitle:"iptv_title",iptvSetupTitle:"iptv_setup_title",iptvSetupSub:"iptv_setup_sub",iptvModeXtream:"iptv_login",iptvModeM3u:"iptv_m3u",iptvServerLbl:"iptv_server",iptvUserLbl:"iptv_user",iptvPassLbl:"iptv_pass",iptvPlaylistLbl:"iptv_playlist",iptvConnect:"iptv_connect",iptvPrivacy:"iptv_privacy",iptvSearchBtn:"iptv_search_btn",iptvMore:"iptv_more",iptvDisconnect:"iptv_other"};
      Object.keys(texts).forEach(id => { const el = byId(id); if (el) el.textContent = t(texts[id]); }); search.placeholder = t("iptv_search_ph");
      const labels = {live:"iptv_live",movie:"iptv_movies",series:"iptv_series"}; kinds.querySelectorAll("[data-kind]").forEach(button => button.textContent = t(labels[button.dataset.kind])); renderCategories();
    }

    document.querySelectorAll("[data-iptv-mode]").forEach(button => button.addEventListener("click", () => setConnectMode(button.dataset.iptvMode)));
    kinds.querySelectorAll("[data-kind]").forEach(button => button.addEventListener("click", () => setKind(button.dataset.kind)));
    byId("iptvConnect").addEventListener("click", connect); byId("iptvClose").addEventListener("click", close); byId("iptvDisconnect").addEventListener("click", disconnect);
    byId("iptvSearchBtn").addEventListener("click", () => { catalogNavigation(); loadCatalog(false); }); category.addEventListener("change", () => { catalogNavigation(); loadCatalog(false); }); more.addEventListener("click", () => loadCatalog(true));
    back.addEventListener("click", () => setKind("series")); search.addEventListener("keydown", event => { if (event.key === "Enter") loadCatalog(false); });
    search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { catalogNavigation(); loadCatalog(false); }, 450); });
    [byId("iptvServer"),byId("iptvUser"),byId("iptvPass"),byId("iptvPlaylist")].forEach(input => input.addEventListener("keydown", event => { if (event.key === "Enter") connect(); }));
    document.addEventListener("keydown", event => { if (event.key === "Escape" && root.classList.contains("show")) close(); });
    localize(); showSetup();
    return { open, close, setSource, applyNavigation, source:() => source, localize };
  }

  global.SameCouchIPTV = { create };
})(window);
