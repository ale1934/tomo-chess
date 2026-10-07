from channels.db import database_sync_to_async as db
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from . import services
from .models import Game


class GameConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.code = self.scope["url_route"]["kwargs"]["code"].upper()
        self.group = f"game_{self.code}"
        if not await db(Game.objects.filter(code=self.code).exists)():
            await self.close(code=4404)
            return
        self.token, self.name = await db(services.token_for)(self.scope["user"], self.scope.get("session"))
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()

        # Whoever opens a waiting lobby with a free seat (and is allowed) sits down.
        joined, state, seat = await db(services.join_and_snapshot)(self.code, self.token, self.name)
        await self.send_json({"type": "hello", "seat": seat})
        if joined:
            await self.channel_layer.group_send(self.group, {"type": "broadcast", "payload": state})
        else:
            await self.send_json(state)

    async def disconnect(self, code):
        if hasattr(self, "group"):
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive_json(self, content, **kwargs):
        kind = content.get("type")
        if kind == "chat":
            text = str(content.get("text", "")).strip()[:300]
            if text and self.token:
                await self.channel_layer.group_send(self.group, {
                    "type": "broadcast",
                    "payload": {"type": "chat", "name": self.name, "text": text},
                })
        elif kind in services.ACTIONS:
            state, error = await db(services.apply)(self.code, self.token, content)
            if error:
                await self.send_json({"type": "error", "message": error})
            elif state:
                await self.channel_layer.group_send(self.group, {"type": "broadcast", "payload": state})

    async def broadcast(self, event):
        await self.send_json(event["payload"])


class NotifyConsumer(AsyncJsonWebsocketConsumer):
    """Personal channel for friend requests and challenges."""

    async def connect(self):
        user = self.scope["user"]
        if not user.is_authenticated:
            await self.close()
            return
        self.group = f"user_{user.id}"
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()

    async def disconnect(self, code):
        if hasattr(self, "group"):
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def notify(self, event):
        await self.send_json(event["payload"])
