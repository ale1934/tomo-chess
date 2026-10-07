(() => {
  const cfg = JSON.parse(document.getElementById("cfg").textContent);
  const $ = (s) => document.querySelector(s);
  const FILES = "abcdefgh";
  const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟\uFE0E" };

  let ws, retry = 500;
  let seat = "spectator", state = null, recvAt = 0;
  let pieces = {}, selected = null, flagSent = false, flashTimer;
  let pieceSet = "cburnett";
  try { pieceSet = localStorage.getItem("rookery.pieces") || pieceSet; } catch {}

  // Builds the element for one piece: an SVG image, or a text glyph for the "glyph" set.
  function pieceEl(p) {
    if (pieceSet === "glyph") {
      const s = document.createElement("span");
      s.className = "p " + (p.c === "white" ? "w" : "b");
      s.textContent = GLYPH[p.t];
      return s;
    }
    const img = document.createElement("img");
    img.className = "p"; img.alt = ""; img.draggable = false;
    img.src = `${cfg.piece_base}${pieceSet}/${p.c === "white" ? "w" : "b"}${p.t.toUpperCase()}.svg`;
    return img;
  }

  const boardEl = $("#board");
  const isPlayer = () => seat !== "spectator";
  const flipped = () => seat === "black";
  const send = (o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));

  // ---------- connection ----------
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/game/${cfg.code}/`);
    ws.onopen = () => { retry = 500; };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = (e) => {
      if (e.code === 4404) return;
      $("#status").textContent = "Connection lost - reconnecting…";
      setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
    };
  }

  function handle(m) {
    if (m.type === "hello") { seat = m.seat; if (state) render(); }
    else if (m.type === "state") {
      state = m; recvAt = performance.now(); selected = null; flagSent = false;
      parseFen(); render();
    }
    else if (m.type === "chat") addChat(m);
    else if (m.type === "error") flash(m.message);
  }

  function flash(msg) {
    $("#flash").textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => ($("#flash").textContent = ""), 3500);
  }

  // ---------- board ----------
  function parseFen() {
    pieces = {};
    state.fen.split(" ")[0].split("/").forEach((row, i) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += +ch;
        else { pieces[FILES[f] + (8 - i)] = { t: ch.toLowerCase(), c: ch === ch.toUpperCase() ? "white" : "black" }; f++; }
      }
    });
  }

  const canMove = () => state && state.status === "active" && isPlayer() && state.turn === seat;

  function renderBoard() {
    const last = state.moves.length ? state.moves[state.moves.length - 1] : "";
    const targets = selected ? state.legal.filter((u) => u.startsWith(selected)).map((u) => u.slice(2, 4)) : [];
    const frag = document.createDocumentFragment();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const f = flipped() ? 7 - c : c, rk = flipped() ? r + 1 : 8 - r, sq = FILES[f] + rk;
        const d = document.createElement("div");
        d.dataset.sq = sq;
        d.className = "sq " + ((f + rk) % 2 === 1 ? "dark" : "light");
        if (last && (sq === last.slice(0, 2) || sq === last.slice(2, 4))) d.classList.add("last");
        if (sq === selected) d.classList.add("sel");
        if (sq === state.check_sq) d.classList.add("check");
        if (targets.includes(sq)) { d.classList.add("target"); if (pieces[sq]) d.classList.add("cap"); }
        const p = pieces[sq];
        if (p) {
          if (canMove() && p.c === seat) d.classList.add("mine");
          d.append(pieceEl(p));
        }
        if (targets.includes(sq)) d.classList.add("mine");
        if (c === 0) { const i = document.createElement("i"); i.className = "rk"; i.textContent = rk; d.append(i); }
        if (r === 7) { const i = document.createElement("i"); i.className = "fl"; i.textContent = FILES[f]; d.append(i); }
        frag.append(d);
      }
    }
    boardEl.replaceChildren(frag);
  }

  boardEl.addEventListener("click", (e) => {
    const el = e.target.closest(".sq");
    if (!el || !canMove()) return;
    const sq = el.dataset.sq;
    if (selected) {
      const ucis = state.legal.filter((u) => u.startsWith(selected + sq));
      if (ucis.length === 1) { send({ type: "move", uci: ucis[0] }); selected = null; return renderBoard(); }
      if (ucis.length > 1) return askPromotion(selected, sq);
    }
    const p = pieces[sq];
    selected = p && p.c === seat && sq !== selected ? sq : null;
    renderBoard();
  });

  function askPromotion(from, to) {
    const box = $("#promo");
    box.replaceChildren();
    for (const t of ["q", "r", "b", "n"]) {
      const b = document.createElement("button");
      b.className = seat === "white" ? "w" : "";
      b.append(pieceEl({ t, c: seat }));
      b.setAttribute("aria-label", "Promote to " + t);
      b.onclick = () => { box.hidden = true; send({ type: "move", uci: from + to + t }); selected = null; renderBoard(); };
      box.append(b);
    }
    box.hidden = false;
  }

  const picker = $("#piece-set");
  picker.value = pieceSet;
  picker.addEventListener("change", () => {
    pieceSet = picker.value;
    try { localStorage.setItem("rookery.pieces", pieceSet); } catch {}
    if (state) renderBoard();
  });

  // ---------- panels ----------
  const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function statusText() {
    if (state.status === "waiting") return isPlayer() ? "Waiting for an opponent…" : "Waiting for players…";
    if (state.status === "finished") {
      const why = state.reason ? ` - ${state.reason}` : "";
      if (state.result === "1-0") return `White wins${why}`;
      if (state.result === "0-1") return `Black wins${why}`;
      if (state.result === "1/2-1/2") return `Draw${why}`;
      return "Game aborted";
    }
    if (!isPlayer()) return `${capital(state.turn)} to move`;
    return state.turn === seat ? "Your move" : "Opponent's move";
  }

  function render() {
    if (!state) return;
    const [top, bot] = flipped() ? ["white", "black"] : ["black", "white"];
    for (const [id, col] of [["top", top], ["bot", bot]]) {
      const name = state[col];
      $("#name-" + id).textContent = (name || "Waiting…") + (seat === col ? " (you)" : "") + (col === "white" ? "  ♔" : "  ♚");
    }
    renderBoard();

    const active = state.status === "active", waiting = state.status === "waiting", done = state.status === "finished";
    $("#status").textContent = statusText();
    $("#lobby").hidden = !waiting;
    $("#b-resign").hidden = !(active && isPlayer());
    $("#b-draw").hidden = !(active && isPlayer());
    $("#b-abort").hidden = !(isPlayer() && (waiting || (active && state.moves.length < 2)));
    $("#b-home").hidden = !done;

    const bar = $("#drawbar"), mine = seat === "white" ? "w" : "b";
    if (active && isPlayer() && state.draw_offer) {
      bar.innerHTML = state.draw_offer === mine
        ? '<span class="muted">Draw offer sent.</span>'
        : '<div class="row2"><span>Opponent offers a draw.</span><button class="small primary" data-a="draw_accept">Accept</button><button class="small" data-a="draw_decline">Decline</button></div>';
    } else bar.textContent = "";

    renderMoves();
    tick();
  }

  function renderMoves() {
    const box = $("#moves");
    if (!state.san.length) { box.innerHTML = '<span class="muted">Moves will appear here.</span>'; return; }
    box.replaceChildren();
    for (let i = 0; i < state.san.length; i += 2) {
      const row = document.createElement("div");
      row.className = "mv";
      const n = document.createElement("span"); n.className = "n"; n.textContent = i / 2 + 1 + ".";
      row.append(n);
      for (const j of [i, i + 1]) {
        const s = document.createElement("span");
        s.textContent = state.san[j] || "";
        if (j === state.san.length - 1) { const w = document.createElement("span"); w.className = "cur"; w.textContent = s.textContent; s.replaceChildren(w); }
        row.append(s);
      }
      box.append(row);
    }
    box.scrollTop = box.scrollHeight;
  }

  $("#drawbar").addEventListener("click", (e) => { const a = e.target.dataset.a; if (a) send({ type: a }); });
  $("#b-draw").onclick = () => send({ type: "draw_offer" });
  $("#b-resign").onclick = () => confirm("Resign this game?") && send({ type: "resign" });
  $("#b-abort").onclick = () => confirm("Abort this game?") && send({ type: "abort" });
  $("#copy-link").onclick = async (e) => {
    try { await navigator.clipboard.writeText(location.href); e.target.textContent = "Copied!"; }
    catch { prompt("Copy this link:", location.href); }
  };

  // ---------- clocks ----------
  function remaining(col) {
    let ms = state[col + "_ms"];
    if (state.clock_running && state.turn === col) ms -= performance.now() - recvAt;
    return Math.max(0, ms);
  }
  function fmt(ms) {
    if (!state.initial) return "∞";
    const s = ms / 1000;
    if (s < 10) return s.toFixed(1);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(ss).padStart(2, "0");
  }
  function tick() {
    if (!state) return;
    const [top, bot] = flipped() ? ["white", "black"] : ["black", "white"];
    for (const [id, col] of [["top", top], ["bot", bot]]) {
      const ms = remaining(col);
      const clk = $("#clock-" + id);
      clk.textContent = fmt(ms);
      clk.classList.toggle("low", !!state.initial && ms < 20000 && state.status !== "waiting");
      $("#p-" + id).classList.toggle("turn", state.status === "active" && state.turn === col);
    }
    // Ask the server to verify a timeout (it re-checks, so a wrong client clock can't end a game).
    if (state.clock_running && isPlayer() && !flagSent && remaining(state.turn) <= 0) {
      flagSent = true; send({ type: "flag" });
      setTimeout(() => (flagSent = false), 2000);
    }
  }
  setInterval(tick, 100);

  // ---------- chat ----------
  function addChat(m) {
    const log = $("#chat-log"), d = document.createElement("div");
    const b = document.createElement("b"); b.textContent = m.name + " ";
    d.append(b, document.createTextNode(m.text));
    log.append(d); log.scrollTop = log.scrollHeight;
  }
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const i = $("#chat-input");
    if (i.value.trim()) send({ type: "chat", text: i.value });
    i.value = "";
  });

  connect();
})();
