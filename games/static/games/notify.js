(() => {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let retry = 1000;

  function toast(p) {
    const a = document.createElement("a");
    a.className = "toast";
    a.href = p.url || "#";
    const b = document.createElement("b");
    b.textContent = p.title || "";
    const s = document.createElement("span");
    s.textContent = p.body || "";
    a.append(b, s);
    document.getElementById("toasts").append(a);
    setTimeout(() => a.remove(), 10000);
    // keep the lobby's friend lists fresh
    if (["friend_request", "friend_accepted"].includes(p.kind) && location.pathname === "/") {
      setTimeout(() => location.reload(), 1500);
    }
  }

  function connect() {
    const ws = new WebSocket(`${proto}://${location.host}/ws/notify/`);
    ws.onopen = () => { retry = 1000; };
    ws.onmessage = (e) => toast(JSON.parse(e.data));
    ws.onclose = () => setTimeout(connect, (retry = Math.min(retry * 2, 15000)));
  }
  connect();
})();
