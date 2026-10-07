"""Server-authoritative game logic. Everything here is synchronous and DB-backed;
the websocket consumer calls it through database_sync_to_async."""
import chess
from django.db import transaction
from django.utils import timezone

from .models import Game

ACTIONS = {"move", "resign", "abort", "draw_offer", "draw_accept", "draw_decline", "flag"}


# ---------- identity ----------
def token_for(user, session):
    """Return (token, display name) for an account user or an anonymous guest."""
    if user is not None and user.is_authenticated:
        return f"u:{user.id}", user.username
    gid = session.get("guest_id") if session is not None else None
    if gid:
        return f"g:{gid}", f"Guest-{gid[:4]}"
    return None, None


def seat_of(game, token):
    if token and token == game.white_token:
        return "white"
    if token and token == game.black_token:
        return "black"
    return "spectator"


# ---------- board / clocks ----------
def replay(game):
    board, sans = chess.Board(), []
    for uci in game.move_list:
        mv = chess.Move.from_uci(uci)
        sans.append(board.san(mv))
        board.push(mv)
    return board, sans


def clock_running(game):
    return bool(game.status == Game.ACTIVE and game.initial_seconds and len(game.move_list) >= 2)


def clocks(game):
    """Remaining (white_ms, black_ms) right now. Clocks start once both sides have moved."""
    w, b = game.white_ms, game.black_ms
    if clock_running(game) and game.last_move_at:
        elapsed = int((timezone.now() - game.last_move_at).total_seconds() * 1000)
        if len(game.move_list) % 2 == 0:
            w -= elapsed
        else:
            b -= elapsed
    return max(w, 0), max(b, 0)


def serialize(game):
    board, sans = replay(game)
    w, b = clocks(game)
    active = game.status == Game.ACTIVE
    return {
        "type": "state",
        "code": game.code,
        "status": game.status,
        "white": game.white_name,
        "black": game.black_name,
        "fen": board.fen(),
        "moves": game.move_list,
        "san": sans,
        "turn": "white" if board.turn else "black",
        "legal": [m.uci() for m in board.legal_moves] if active else [],
        "check_sq": chess.square_name(board.king(board.turn)) if board.is_check() else None,
        "white_ms": w,
        "black_ms": b,
        "clock_running": clock_running(game),
        "initial": game.initial_seconds,
        "increment": game.increment_seconds,
        "label": game.time_label,
        "result": game.result,
        "reason": game.reason,
        "draw_offer": game.draw_offer,
    }


def finish(game, result, reason):
    w, b = clocks(game)  # freeze the clocks
    game.white_ms, game.black_ms = w, b
    game.status, game.result, game.reason, game.draw_offer = Game.FINISHED, result, reason, ""
    game.save()


# ---------- joining ----------
def try_join(game, token, name):
    if game.status != Game.WAITING or not token:
        return False
    if token in (game.white_token, game.black_token):
        return False
    if game.invited_token and game.invited_token != token:
        return False
    if not game.white_token:
        game.white_token, game.white_name = token, name
    elif not game.black_token:
        game.black_token, game.black_name = token, name
    else:
        return False
    if game.white_token and game.black_token:
        game.status = Game.ACTIVE
        game.last_move_at = timezone.now()
    game.save()
    return True


@transaction.atomic
def join_and_snapshot(code, token, name):
    game = Game.objects.select_for_update().get(code=code)
    joined = try_join(game, token, name)
    return joined, serialize(game), seat_of(game, token)


# ---------- player actions ----------
@transaction.atomic
def apply(code, token, msg):
    """Returns (state_or_None, error_or_None)."""
    game = Game.objects.select_for_update().get(code=code)
    seat = seat_of(game, token)
    kind = msg.get("type")
    if seat == "spectator":
        return None, "You are not a player in this game."
    mine = "w" if seat == "white" else "b"
    n_moves = len(game.move_list)

    if kind == "abort":
        if game.status == Game.WAITING or (game.status == Game.ACTIVE and n_moves < 2):
            finish(game, "*", "aborted")
            return serialize(game), None
        return None, "It's too late to abort - resign instead."

    if game.status != Game.ACTIVE:
        return None, "The game isn't in progress."

    if kind == "move":
        return _move(game, seat, msg)
    if kind == "flag":
        return _flag(game)
    if kind == "resign":
        finish(game, "0-1" if seat == "white" else "1-0", "resignation")
    elif kind == "draw_offer":
        if game.draw_offer and game.draw_offer != mine:
            finish(game, "1/2-1/2", "agreement")
        else:
            game.draw_offer = mine
            game.save()
    elif kind == "draw_accept":
        if game.draw_offer and game.draw_offer != mine:
            finish(game, "1/2-1/2", "agreement")
        else:
            return None, "There's no draw offer to accept."
    elif kind == "draw_decline":
        if game.draw_offer and game.draw_offer != mine:
            game.draw_offer = ""
            game.save()
        else:
            return None, None
    return serialize(game), None


def _flag(game):
    """Called when a client believes the side to move ran out of time. The server verifies."""
    if not clock_running(game):
        return None, None
    w, b = clocks(game)
    white_to_move = len(game.move_list) % 2 == 0
    if (w if white_to_move else b) > 0:
        return None, None  # not actually out of time
    board, _ = replay(game)
    winner = chess.BLACK if white_to_move else chess.WHITE
    if board.has_insufficient_material(winner):
        finish(game, "1/2-1/2", "timeout vs insufficient material")
    else:
        finish(game, "0-1" if white_to_move else "1-0", "timeout")
    return serialize(game), None


def _move(game, seat, msg):
    board, _ = replay(game)
    if (seat == "white") != board.turn:
        return None, "It's not your turn."
    try:
        mv = chess.Move.from_uci(str(msg.get("uci", "")))
    except ValueError:
        return None, "That move wasn't understood."
    if mv not in board.legal_moves:
        return None, "Illegal move."

    if clock_running(game):
        w, b = clocks(game)
        remaining = w if board.turn else b
        if remaining <= 0:
            return _flag(game)
        remaining += game.increment_seconds * 1000
        if board.turn:
            game.white_ms = remaining
        else:
            game.black_ms = remaining

    board.push(mv)
    game.moves = f"{game.moves} {mv.uci()}".strip()
    game.last_move_at = timezone.now()
    game.draw_offer = ""
    outcome = board.outcome(claim_draw=True)  # also auto-draws on threefold / 50-move
    if outcome:
        finish(game, outcome.result(), outcome.termination.name.replace("_", " ").lower())
    else:
        game.save()
    return serialize(game), None
