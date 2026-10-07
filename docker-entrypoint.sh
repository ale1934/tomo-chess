#!/bin/sh
set -e
python manage.py migrate --noinput
# Render provides $PORT; default to 8000 for local `docker run`.
exec daphne -b 0.0.0.0 -p "${PORT:-8000}" --proxy-headers chessproject.asgi:application
