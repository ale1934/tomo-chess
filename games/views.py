import random
import uuid

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib import messages
from django.contrib.auth import get_user_model, login
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import UserCreationForm
from django.db.models import Q
from django.templatetags.static import static
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_POST

from .models import Friendship, Game

User = get_user_model()

PRESETS = [  # (label, category, initial seconds, increment)
    ("1+0", "Bullet", 60, 0), ("2+1", "Bullet", 120, 1),
    ("3+0", "Blitz", 180, 0), ("3+2", "Blitz", 180, 2), ("5+0", "Blitz", 300, 0), ("5+3", "Blitz", 300, 3),
    ("10+0", "Rapid", 600, 0), ("15+10", "Rapid", 900, 10),
    ("30+0", "Classical", 1800, 0), ("Unlimited", "No clock", 0, 0),
]


def notify(user_id, payload):
    """Push a realtime message to a user's open pages. Never lets a layer hiccup break a request."""
    try:
        async_to_sync(get_channel_layer().group_send)(f"user_{user_id}", {"type": "notify", "payload": payload})
    except Exception:
        pass


def _presets():
    return [{"label": l, "name": n, "value": f"{s},{i}", "default": l == "10+0"} for l, n, s, i in PRESETS]


# ---------- pages ----------
def home(request):
    ctx = {"presets": _presets()}
    if request.user.is_authenticated:
        me = request.user
        rels = Friendship.objects.filter(Q(from_user=me) | Q(to_user=me)).select_related("from_user", "to_user")
        ctx["friends"] = [{"user": r.other(me), "pk": r.pk} for r in rels if r.status == Friendship.ACCEPTED]
        ctx["incoming"] = [r for r in rels if r.status == Friendship.PENDING and r.to_user_id == me.id]
        ctx["outgoing"] = [r for r in rels if r.status == Friendship.PENDING and r.from_user_id == me.id]
        token = f"u:{me.id}"
        games = list(Game.objects.filter(Q(white_token=token) | Q(black_token=token)).order_by("-updated")[:10])
        for g in games:
            opp = g.black_name if g.white_token == token else g.white_name
            g.opp = opp or "waiting for opponent"
        ctx["games"] = games
    return render(request, "games/home.html", ctx)


def register(request):
    form = UserCreationForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        login(request, form.save())
        return redirect("home")
    return render(request, "games/register.html", {"form": form})


def game_page(request, code):
    game = get_object_or_404(Game, code=code.upper())
    if not request.user.is_authenticated and "guest_id" not in request.session:
        request.session["guest_id"] = uuid.uuid4().hex[:12]  # anonymous identity for joining by code
    cfg = {"code": game.code, "label": game.time_label, "piece_base": static("games/pieces/")}
    return render(request, "games/game.html", {"game": game, "cfg": cfg})


# ---------- games ----------
@require_POST
def join_code(request):
    code = request.POST.get("code", "").strip().upper()
    if Game.objects.filter(code=code).exists():
        return redirect("game", code=code)
    messages.error(request, f"No game found with code “{code}”. Check the code and try again.")
    return redirect("home")


def _time_control(post):
    try:
        if post.get("preset") == "custom":
            initial = int(post.get("custom_minutes") or 10) * 60
            inc = int(post.get("custom_increment") or 0)
        else:
            initial, inc = (int(x) for x in post.get("preset", "600,0").split(","))
    except ValueError:
        initial, inc = 600, 0
    if initial:
        initial = min(max(initial, 60), 180 * 60)
    return initial, min(max(inc, 0), 60)


@login_required
@require_POST
def create_game(request):
    initial, inc = _time_control(request.POST)
    color = request.POST.get("color", "random")
    if color == "random":
        color = random.choice(["white", "black"])
    token, name = f"u:{request.user.id}", request.user.username

    game = Game(initial_seconds=initial, increment_seconds=inc, white_ms=initial * 1000, black_ms=initial * 1000)
    setattr(game, f"{color}_token", token)
    setattr(game, f"{color}_name", name)

    friend = None
    invite = request.POST.get("invite", "").strip()
    if invite:
        friend = User.objects.filter(username=invite).first()
        rel = Friendship.between(request.user, friend) if friend else None
        if not rel or rel.status != Friendship.ACCEPTED:
            messages.error(request, "You can only invite friends.")
            return redirect("home")
        game.invited_token = f"u:{friend.id}"
    game.save()

    if friend:
        notify(friend.id, {"kind": "challenge", "title": f"{name} challenged you",
                           "body": f"{game.time_label} · tap to play", "url": f"/game/{game.code}/"})
    return redirect("game", code=game.code)


# ---------- friends ----------
@login_required
@require_POST
def friend_add(request):
    me = request.user
    target = User.objects.filter(username__iexact=request.POST.get("username", "").strip()).first()
    if not target:
        messages.error(request, "No player with that username.")
    elif target == me:
        messages.error(request, "You can't add yourself.")
    else:
        rel = Friendship.between(me, target)
        if rel is None:
            Friendship.objects.create(from_user=me, to_user=target)
            notify(target.id, {"kind": "friend_request", "title": f"{me.username} sent a friend request",
                               "body": "Tap to review it", "url": "/"})
            messages.success(request, f"Friend request sent to {target.username}.")
        elif rel.status == Friendship.ACCEPTED:
            messages.info(request, f"You're already friends with {target.username}.")
        elif rel.to_user_id == me.id:  # they already asked us: accept
            rel.status = Friendship.ACCEPTED
            rel.save()
            notify(target.id, {"kind": "friend_accepted", "title": f"{me.username} is now your friend", "url": "/"})
            messages.success(request, f"You and {target.username} are now friends.")
        else:
            messages.info(request, "Request already sent - waiting for them to accept.")
    return redirect("home")


@login_required
@require_POST
def friend_action(request, pk, action):
    me = request.user
    rel = get_object_or_404(Friendship.objects.filter(Q(from_user=me) | Q(to_user=me)), pk=pk)
    if action == "accept" and rel.to_user_id == me.id and rel.status == Friendship.PENDING:
        rel.status = Friendship.ACCEPTED
        rel.save()
        notify(rel.from_user_id, {"kind": "friend_accepted", "title": f"{me.username} accepted your request", "url": "/"})
    elif action in ("decline", "cancel", "remove"):
        rel.delete()
    return redirect("home")
