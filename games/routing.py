from django.urls import re_path

from . import consumers

websocket_urlpatterns = [
    re_path(r"^ws/game/(?P<code>[A-Za-z0-9]{4,10})/$", consumers.GameConsumer.as_asgi()),
    re_path(r"^ws/notify/$", consumers.NotifyConsumer.as_asgi()),
]
