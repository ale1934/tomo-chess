(() => {
  const cfg = JSON.parse(document.getElementById("cfg").textContent);
  const $ = (s) => document.querySelector(s);
  const FILES = "abcdefgh";
  const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟\uFE0E" };

  let ws, retry = 500;
  let seat = "spectator", state = null, recvAt = 0;
  let pieces = {}, selected = null, premove = null, flagSent = false, flashTimer;
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
      if (m.type === "hello") {
          seat = m.seat;
          if (state) render();
      }
      else if (m.type === "state") {
        state = m;
        recvAt = performance.now();
        selected = null;
        flagSent = false;

        parseFen();
        render();

        // A new server state may mean that it is now our turn.
        // Try the queued premove immediately.
        tryPremove();
      }
      else if (m.type === "chat") {
          addChat(m);
      }
      else if (m.type === "rematch_requested") {
          state.rematch_white = m.white;
          state.rematch_black = m.black;
          render();
      }
      else if (m.type === "rematch_created") {
          location.href = `/game/${m.code}/`;
      }
      else if (m.type === "error") {
          flash(m.message);
      }
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

  // ---------- premove move generation ----------
  function pseudoTargets(from) {
    const p = pieces[from];
    if (!p) return [];

    const out = [];
    const file = FILES.indexOf(from[0]);
    const rank = Number(from[1]);

    const add = (f, r) => {
      if (f < 0 || f > 7 || r < 1 || r > 8) return false;

      const sq = FILES[f] + r;
      const target = pieces[sq];

      // Own piece blocks the square.
      if (target && target.c === p.c) return false;

      out.push(sq);

      // Enemy piece can be captured, but blocks sliders behind it.
      return !target;
    };

    // Pawn
    if (p.t === "p") {
      const dir = p.c === "white" ? 1 : -1;
      const startRank = p.c === "white" ? 2 : 7;

      // Forward one square
      const one = FILES[file] + (rank + dir);

      if (
        rank + dir >= 1 &&
        rank + dir <= 8 &&
        !pieces[one]
      ) {
        out.push(one);

        // Initial two-square move
        const two = FILES[file] + (rank + dir * 2);

        if (
          rank === startRank &&
          !pieces[two]
        ) {
          out.push(two);
        }
      }

      // Captures
      for (const df of [-1, 1]) {
        const nf = file + df;
        const nr = rank + dir;

        if (nf < 0 || nf > 7 || nr < 1 || nr > 8) continue;

        const sq = FILES[nf] + nr;
        const target = pieces[sq];

        if (target && target.c !== p.c) {
          out.push(sq);
        }

        // En passant
        const fenParts = state.fen.split(" ");
        const ep = fenParts[3];

        if (ep && ep === sq) {
          out.push(sq);
        }
      }

      return [...new Set(out)];
    }

    // Knight
    if (p.t === "n") {
      const jumps = [
        [1, 2], [2, 1],
        [2, -1], [1, -2],
        [-1, -2], [-2, -1],
        [-2, 1], [-1, 2]
      ];

      for (const [df, dr] of jumps) {
        add(file + df, rank + dr);
      }

      return [...new Set(out)];
    }

    // Bishop / Rook / Queen
    const directions = [];

    if (p.t === "b" || p.t === "q") {
      directions.push(
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1]
      );
    }

    if (p.t === "r" || p.t === "q") {
      directions.push(
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1]
      );
    }

    if (p.t === "b" || p.t === "r" || p.t === "q") {
      for (const [df, dr] of directions) {
        let f = file + df;
        let r = rank + dr;

        while (f >= 0 && f < 8 && r >= 1 && r <= 8) {
          const canContinue = add(f, r);

          if (!canContinue) break;

          f += df;
          r += dr;
        }
      }

      return [...new Set(out)];
    }

    // King
    if (p.t === "k") {
      for (let df = -1; df <= 1; df++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (df === 0 && dr === 0) continue;
          add(file + df, rank + dr);
        }
      }

      // Castling.
      // We intentionally ignore check and attacked squares here.
      // FEN castling rights still have to permit it.
      const fenParts = state.fen.split(" ");
      const rights = fenParts[2] || "-";

      if (p.c === "white" && from === "e1") {
        // O-O
        if (
          rights.includes("K") &&
          !pieces.f1 &&
          !pieces.g1 &&
          pieces.h1?.t === "r" &&
          pieces.h1?.c === "white"
        ) {
          out.push("g1");
        }

        // O-O-O
        if (
          rights.includes("Q") &&
          !pieces.b1 &&
          !pieces.c1 &&
          !pieces.d1 &&
          pieces.a1?.t === "r" &&
          pieces.a1?.c === "white"
        ) {
          out.push("c1");
        }
      }

      if (p.c === "black" && from === "e8") {
        // O-O
        if (
          rights.includes("k") &&
          !pieces.f8 &&
          !pieces.g8 &&
          pieces.h8?.t === "r" &&
          pieces.h8?.c === "black"
        ) {
          out.push("g8");
        }

        // O-O-O
        if (
          rights.includes("q") &&
          !pieces.b8 &&
          !pieces.c8 &&
          !pieces.d8 &&
          pieces.a8?.t === "r" &&
          pieces.a8?.c === "black"
        ) {
          out.push("c8");
        }
      }

      return [...new Set(out)];
    }

    return [];
  }

  const canMove = () => state && state.status === "active" && isPlayer() && state.turn === seat;

  function renderBoard() {
    const last = state.moves.length
      ? state.moves[state.moves.length - 1]
      : "";

    // Normal chess moves: only server-confirmed legal moves.
    const targets = selected && canMove()
      ? state.legal
          .filter((u) => u.startsWith(selected))
          .map((u) => u.slice(2, 4))
      : [];

    // Premove moves: pseudo-legal moves generated entirely on the client.
    // These intentionally ignore check, pins, and whose turn it is.
    const premoveTargets = selected && !canMove()
      ? pseudoTargets(selected)
      : [];

    // The queued premove gets its own special source/destination styling.
    const queuedPremoveFrom = premove ? premove.from : null;
    const queuedPremoveTo = premove ? premove.to : null;

    const frag = document.createDocumentFragment();

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const f = flipped() ? 7 - c : c;
        const rk = flipped() ? r + 1 : 8 - r;
        const sq = FILES[f] + rk;

        const d = document.createElement("div");
        d.dataset.sq = sq;

        d.className =
          "sq " +
          ((f + rk) % 2 === 1 ? "dark" : "light");

        // Last server-confirmed move
        if (
          last &&
          (sq === last.slice(0, 2) ||
          sq === last.slice(2, 4))
        ) {
          d.classList.add("last");
        }

        // Normal move selection
        if (sq === selected) {
          d.classList.add("sel");
        }

        // Check indicator
        if (sq === state.check_sq) {
          d.classList.add("check");
        }

        // Normal legal move targets
        if (targets.includes(sq)) {
          d.classList.add("target");

          if (pieces[sq]) {
            d.classList.add("cap");
          }
        }

        // Premove possible destinations.
        if (premoveTargets.includes(sq)) {
          d.classList.add("premove-target");

          if (pieces[sq]) {
            d.classList.add("premove-cap");
          }
        }

        // Queued premove source square.
        if (sq === queuedPremoveFrom) {
          d.classList.add("premove-from");
        }

        // Queued premove destination.
        if (sq === queuedPremoveTo) {
          d.classList.add("premove-to");
        }

        const p = pieces[sq];

        if (p) {
          if (canMove() && p.c === seat) {
            d.classList.add("mine");
          }

          // Allow selecting your pieces even while waiting for your turn.
          if (
            isPlayer() &&
            state.status === "active" &&
            p.c === seat
          ) {
            d.classList.add("mine");
          }

          d.append(pieceEl(p));
        }

        if (targets.includes(sq)) {
          d.classList.add("mine");
        }

        if (c === 0) {
          const i = document.createElement("i");
          i.className = "rk";
          i.textContent = rk;
          d.append(i);
        }

        if (r === 7) {
          const i = document.createElement("i");
          i.className = "fl";
          i.textContent = FILES[f];
          d.append(i);
        }

        frag.append(d);
      }
    }

    boardEl.replaceChildren(frag);
  }

  boardEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();

    if (premove || selected) {
      premove = null;
      selected = null;
      renderBoard();
    }
  });

  boardEl.addEventListener("click", (e) => {
    const el = e.target.closest(".sq");
    if (!el || !isPlayer() || state.status !== "active") return;

    const sq = el.dataset.sq;
    const p = pieces[sq];

    // ------------------------------------------------------------
    // YOUR TURN
    // ------------------------------------------------------------
    if (canMove()) {
      // If a premove exists, clicking normally clears it.
      premove = null;

      if (selected) {
        const ucis = state.legal.filter(
          (u) => u.startsWith(selected + sq)
        );

        // Normal move
        if (ucis.length === 1) {
          send({
            type: "move",
            uci: ucis[0]
          });

          selected = null;
          return renderBoard();
        }

        // Promotion
        if (ucis.length > 1) {
          return askPromotion(selected, sq, false);
        }
      }

      selected =
        p &&
        p.c === seat &&
        sq !== selected
          ? sq
          : null;

      return renderBoard();
    }

    // ------------------------------------------------------------
    // NOT YOUR TURN -> PREMOVE
    // ------------------------------------------------------------

    // Clicking one of your pieces selects it for a premove.
    if (!selected) {
      if (p && p.c === seat) {
        selected = sq;
        renderBoard();
      }

      return;
    }

    // Clicking another one of your pieces changes the selection.
    if (p && p.c === seat) {
      selected = sq;
      renderBoard();
      return;
    }

    // Same square cancels selection.
    if (sq === selected) {
      selected = null;
      renderBoard();
      return;
    }

    // Create the premove.
    const from = selected;
    const to = sq;

    // A normal chess move is 4 characters.
    const uci = from + to;

    // Detect pawn promotion based on the board position.
    const movingPiece = pieces[from];

    if (
      movingPiece &&
      movingPiece.t === "p" &&
      ((movingPiece.c === "white" && to[1] === "8") ||
      (movingPiece.c === "black" && to[1] === "1"))
    ) {
      return askPromotion(from, to, true);
    }

    premove = {
      from,
      to,
      uci
    };

    // Keep the piece selected so its possible premove destinations
    // remain visible. The destination itself gets the red indicator.
    selected = from;

    renderBoard();
  });

  function askPromotion(from, to, isPremove = false) {
    const box = $("#promo");
    box.replaceChildren();

    for (const t of ["q", "r", "b", "n"]) {
      const b = document.createElement("button");

      b.className = seat === "white" ? "w" : "";

      b.append(
        pieceEl({
          t,
          c: seat
        })
      );

      b.setAttribute(
        "aria-label",
        "Promote to " + t
      );

      b.onclick = () => {
        box.hidden = true;

        const uci = from + to + t;

        if (isPremove) {
          premove = {
            from,
            to,
            uci
          };
        } else {
          send({
            type: "move",
            uci
          });
        }

        selected = isPremove ? from : null;
        renderBoard();
      };

      box.append(b);
    }

    box.hidden = false;
  }


  function tryPremove() {
    if (!premove || !canMove()) return;

    // Check whether our premove is legal in the new position.
    const legal = state.legal.includes(premove.uci);

    if (!legal) {
      // Opponent's move changed the position so the premove
      // is no longer legal.
      premove = null;
      selected = null;
      renderBoard();
      return;
    }

    const uci = premove.uci;

    premove = null;
    selected = null;

    send({
      type: "move",
      uci
    });

    renderBoard();
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
    $("#b-rematch").hidden = !done || !isPlayer();

    const rematchStatus = $("#rematch-status");

    if (done && isPlayer()) {
        const mine = seat === "white"
            ? state.rematch_white
            : state.rematch_black;

        const theirs = seat === "white"
            ? state.rematch_black
            : state.rematch_white;

        if (mine && !theirs) {
            rematchStatus.textContent = "Waiting for your opponent to accept the rematch…";
        } else if (!mine && theirs) {
            rematchStatus.textContent = "Your opponent wants a rematch!";
        } else {
            rematchStatus.textContent = "";
        }
    } else {
        rematchStatus.textContent = "";
    }

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
  $("#b-rematch").onclick = () => { send({ type: "rematch" }); };
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
