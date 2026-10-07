# Rookery - realtime chess with Django Channels

## Run it
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver        # daphne serves HTTP + websockets
```
Open http://127.0.0.1:8000. Run `python manage.py test games` for the tests.

## What's in it
- Accounts: sign up / sign in / sign out on the homepage.
- Friends: send requests by username, accept/decline, challenge a friend (they get a live toast).
- Games: bullet/blitz/rapid/classical presets, custom time + increment, or no clock; pick colour.
- Lobby codes: anyone (including signed-out guests) can join with a 6-character code or link.
- Realtime play over websockets: moves, clocks, draw offers, resign, abort, chat, spectators.
- Server-authoritative: python-chess validates every move; clocks and timeouts are checked server-side.

## Layout
- `games/services.py` - game rules, clocks, actions
- `games/consumers.py` - game + notification websocket consumers
- `games/views.py` - pages, friends, game creation
- `games/static/games/game.js` - board UI and client clocks

## Production notes
Set `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=0`, `DJANGO_ALLOWED_HOSTS`, and `REDIS_URL`
(install `channels-redis`) so multiple processes share websocket traffic. Run with
`daphne chessproject.asgi:application` and run `collectstatic` behind a web server.
# tomo-chess
