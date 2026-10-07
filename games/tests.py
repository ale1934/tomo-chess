from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.test import Client, TransactionTestCase
from django.urls import reverse

from .consumers import GameConsumer
from .models import Friendship, Game

User = get_user_model()


def comm(code, user=None, guest=None):
    c = WebsocketCommunicator(GameConsumer.as_asgi(), f"/ws/game/{code}/")
    c.scope["url_route"] = {"kwargs": {"code": code}}
    c.scope["user"] = user or type("Anon", (), {"is_authenticated": False})()
    c.scope["session"] = {"guest_id": guest} if guest else {}
    return c


async def drain(c, until="state"):
    while True:
        m = await c.receive_json_from(timeout=3)
        if m["type"] == until:
            return m


class FlowTests(TransactionTestCase):
    def test_friends_and_create(self):
        a = User.objects.create_user("alice", password="pw-12345-x")
        b = User.objects.create_user("bob", password="pw-12345-x")
        ca = Client(); ca.login(username="alice", password="pw-12345-x")
        ca.post(reverse("friend_add"), {"username": "bob"})
        rel = Friendship.objects.get()
        cb = Client(); cb.login(username="bob", password="pw-12345-x")
        cb.post(reverse("friend_action", args=[rel.pk, "accept"]))
        self.assertEqual(Friendship.objects.get().status, "accepted")
        r = ca.post(reverse("create_game"), {"preset": "180,2", "color": "white", "invite": "bob"})
        g = Game.objects.get()
        self.assertEqual((g.initial_seconds, g.increment_seconds, g.invited_token), (180, 2, f"u:{b.id}"))
        self.assertEqual(r.status_code, 302)
        self.assertEqual(ca.get("/").status_code, 200)
        self.assertEqual(Client().get("/").status_code, 200)
        self.assertEqual(Client().get(f"/game/{g.code}/").status_code, 200)

    async def test_fools_mate_and_guest_join(self):
        from channels.db import database_sync_to_async as db
        alice = await db(User.objects.create_user)("alice", password="x")
        g = await db(Game.objects.create)(white_token=f"u:{alice.id}", white_name="alice",
                                          initial_seconds=300, white_ms=300000, black_ms=300000)
        w = comm(g.code, user=alice)
        ok, _ = await w.connect(); self.assertTrue(ok)
        st = await drain(w); self.assertEqual(st["status"], "waiting")

        b = comm(g.code, guest="abcd1234")  # anonymous joiner via code
        await b.connect()
        st = await drain(b); self.assertEqual(st["status"], "active"); self.assertEqual(st["black"], "Guest-abcd")
        await drain(w)

        for who, uci in [(w, "f2f3"), (b, "e7e5"), (w, "g2g4"), (b, "d8h4")]:
            await who.send_json_to({"type": "move", "uci": uci})
            st = await drain(w)
            await drain(b)
        self.assertEqual((st["status"], st["result"], st["reason"]), ("finished", "0-1", "checkmate"))

    async def test_illegal_turn_and_timeout(self):
        from channels.db import database_sync_to_async as db
        alice = await db(User.objects.create_user)("al", password="x")
        g = await db(Game.objects.create)(white_token=f"u:{alice.id}", white_name="al", black_token="g:zzzz9999",
                                          black_name="Guest-zzzz", status="active", initial_seconds=60,
                                          white_ms=60000, black_ms=60000, moves="e2e4 e7e5 g1f3")
        from django.utils import timezone; from datetime import timedelta
        await db(Game.objects.filter(pk=g.pk).update)(last_move_at=timezone.now() - timedelta(seconds=120), black_ms=1000)
        w = comm(g.code, user=alice); await w.connect(); await drain(w)
        await w.send_json_to({"type": "move", "uci": "d2d4"})
        err = await drain(w, "error"); self.assertIn("not your turn", err["message"])
        await w.send_json_to({"type": "flag"})
        st = await drain(w); self.assertEqual((st["result"], st["reason"]), ("1-0", "timeout"))
