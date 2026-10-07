import secrets

from django.conf import settings
from django.db import models
from django.db.models import Q

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I confusion


def make_code():
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
        if not Game.objects.filter(code=code).exists():
            return code


class Friendship(models.Model):
    PENDING, ACCEPTED = "pending", "accepted"
    from_user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="requests_sent")
    to_user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="requests_received")
    status = models.CharField(max_length=10, default=PENDING)
    created = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("from_user", "to_user")]

    def __str__(self):
        return f"{self.from_user} -> {self.to_user} ({self.status})"

    @classmethod
    def between(cls, a, b):
        return cls.objects.filter(Q(from_user=a, to_user=b) | Q(from_user=b, to_user=a)).first()

    def other(self, user):
        return self.to_user if self.from_user_id == user.id else self.from_user


class Game(models.Model):
    WAITING, ACTIVE, FINISHED = "waiting", "active", "finished"

    code = models.CharField(max_length=8, unique=True, default=make_code)
    status = models.CharField(max_length=10, default=WAITING)

    # A "token" identifies a player: "u:<user id>" for accounts, "g:<id>" for anonymous guests.
    white_token = models.CharField(max_length=40, blank=True)
    black_token = models.CharField(max_length=40, blank=True)
    white_name = models.CharField(max_length=150, blank=True)
    black_name = models.CharField(max_length=150, blank=True)
    invited_token = models.CharField(max_length=40, blank=True)  # if set, only this player may take the open seat

    initial_seconds = models.PositiveIntegerField(default=600)  # 0 = unlimited
    increment_seconds = models.PositiveIntegerField(default=0)
    white_ms = models.BigIntegerField(default=0)
    black_ms = models.BigIntegerField(default=0)
    last_move_at = models.DateTimeField(null=True, blank=True)

    moves = models.TextField(blank=True)  # space-separated UCI moves
    result = models.CharField(max_length=8, blank=True)  # 1-0, 0-1, 1/2-1/2, *
    reason = models.CharField(max_length=60, blank=True)
    draw_offer = models.CharField(max_length=1, blank=True)  # "w" / "b" / ""

    created = models.DateTimeField(auto_now_add=True)
    updated = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.code

    @property
    def move_list(self):
        return self.moves.split()

    @property
    def time_label(self):
        if not self.initial_seconds:
            return "Unlimited"
        m = self.initial_seconds / 60
        m = int(m) if m == int(m) else round(m, 1)
        return f"{m}+{self.increment_seconds}"
